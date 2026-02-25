use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use uuid::Uuid;

use crate::models::{
    Settings, ThreadMetadata, ThreadRunStatus, TranscriptEntry, Workspace, WorkspaceKind,
};

const APP_SUPPORT_SUBDIR: &str = "Library/Application Support/ClaudeDesk";

fn thread_metadata_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn validate_storage_segment<'a>(value: &'a str, label: &str) -> Result<&'a str> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("{label} cannot be empty"));
    }
    if trimmed == "."
        || trimmed == ".."
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains('\0')
    {
        return Err(anyhow!("Invalid {label}"));
    }
    Ok(trimmed)
}

fn write_file_atomic(path: &Path, raw: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .ok_or_else(|| {
            anyhow!(
                "Cannot write file without a name: {}",
                path.to_string_lossy()
            )
        })?;
    let temp_path = path.with_file_name(format!(".{file_name}.tmp-{}", Uuid::new_v4()));
    fs::write(&temp_path, raw)?;
    if let Err(error) = fs::rename(&temp_path, path) {
        let _ = fs::remove_file(&temp_path);
        return Err(error.into());
    }
    Ok(())
}

pub fn app_support_root() -> Result<PathBuf> {
    if let Ok(override_root) = std::env::var("CLAUDE_DESK_APP_SUPPORT_ROOT") {
        if !override_root.trim().is_empty() {
            return Ok(PathBuf::from(override_root));
        }
    }
    let home = dirs::home_dir().ok_or_else(|| anyhow!("Unable to resolve home directory"))?;
    Ok(home.join(APP_SUPPORT_SUBDIR))
}

pub fn ensure_base_dirs() -> Result<PathBuf> {
    let root = app_support_root()?;
    fs::create_dir_all(root.join("agents"))?;
    fs::create_dir_all(root.join("threads"))?;
    if !root.join("workspaces.json").exists() {
        write_file_atomic(&root.join("workspaces.json"), b"[]")?;
    }
    if !root.join("settings.json").exists() {
        let settings = serde_json::to_string_pretty(&Settings::default())?;
        write_file_atomic(&root.join("settings.json"), settings.as_bytes())?;
    }
    Ok(root)
}

fn workspaces_file() -> Result<PathBuf> {
    Ok(ensure_base_dirs()?.join("workspaces.json"))
}

fn settings_file() -> Result<PathBuf> {
    Ok(ensure_base_dirs()?.join("settings.json"))
}

pub fn load_settings() -> Result<Settings> {
    let file = settings_file()?;
    let raw = fs::read_to_string(file)?;
    let settings: Settings = serde_json::from_str(&raw).unwrap_or_default();
    Ok(settings)
}

pub fn save_settings(settings: &Settings) -> Result<()> {
    let file = settings_file()?;
    let raw = serde_json::to_string_pretty(settings)?;
    write_file_atomic(&file, raw.as_bytes())?;
    Ok(())
}

pub fn load_workspaces() -> Result<Vec<Workspace>> {
    let file = workspaces_file()?;
    let raw = fs::read_to_string(file)?;
    let list: Vec<Workspace> = serde_json::from_str(&raw).unwrap_or_default();
    Ok(list)
}

pub fn save_workspaces(workspaces: &[Workspace]) -> Result<()> {
    let file = workspaces_file()?;
    let raw = serde_json::to_string_pretty(workspaces)?;
    write_file_atomic(&file, raw.as_bytes())?;
    Ok(())
}

pub fn add_workspace(path: &str) -> Result<Workspace> {
    let canonical_path = fs::canonicalize(path)
        .with_context(|| format!("Unable to resolve workspace path: {path}"))?;
    let canonical = canonical_path.to_string_lossy().to_string();

    let mut workspaces = load_workspaces()?;
    if let Some(existing) = workspaces
        .iter()
        .find(|workspace| workspace.path == canonical)
    {
        return Ok(existing.clone());
    }

    let now = Utc::now();
    let workspace = Workspace {
        id: Uuid::new_v4().to_string(),
        name: canonical_path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "Workspace".to_string()),
        path: canonical,
        kind: WorkspaceKind::Local,
        rdev_ssh_command: None,
        git_pull_on_master_for_new_threads: false,
        created_at: now,
        updated_at: now,
    };

    workspaces.push(workspace.clone());
    save_workspaces(&workspaces)?;
    fs::create_dir_all(thread_workspace_dir(&workspace.id)?)?;

    Ok(workspace)
}

pub fn add_rdev_workspace(rdev_ssh_command: &str, display_name: Option<&str>) -> Result<Workspace> {
    let normalized_command = rdev_ssh_command.trim();
    if normalized_command.is_empty() {
        return Err(anyhow!("Please enter an rdev ssh command."));
    }

    if !normalized_command.starts_with("rdev ssh") {
        return Err(anyhow!(
            "rdev command must start with `rdev ssh` (example: rdev ssh <mp>/<env>)"
        ));
    }

    let mut workspaces = load_workspaces()?;
    if let Some(existing) = workspaces.iter().find(|workspace| {
        workspace.kind == WorkspaceKind::Rdev
            && workspace.rdev_ssh_command.as_deref() == Some(normalized_command)
    }) {
        return Ok(existing.clone());
    }

    let now = Utc::now();
    let trimmed_display_name = display_name.unwrap_or_default().trim().to_string();
    let fallback_name = normalized_command
        .split_whitespace()
        .skip(2)
        .find(|segment| !segment.starts_with('-'))
        .unwrap_or("rdev")
        .split('/')
        .next_back()
        .unwrap_or("rdev")
        .to_string();
    let workspace_name = if trimmed_display_name.is_empty() {
        fallback_name
    } else {
        trimmed_display_name
    };

    let workspace = Workspace {
        id: Uuid::new_v4().to_string(),
        name: workspace_name,
        path: format!("rdev-workspace-{}", Uuid::new_v4()),
        kind: WorkspaceKind::Rdev,
        rdev_ssh_command: Some(normalized_command.to_string()),
        git_pull_on_master_for_new_threads: false,
        created_at: now,
        updated_at: now,
    };

    workspaces.push(workspace.clone());
    save_workspaces(&workspaces)?;
    fs::create_dir_all(thread_workspace_dir(&workspace.id)?)?;

    Ok(workspace)
}

pub fn remove_workspace(workspace_id: &str) -> Result<bool> {
    let workspace_id = validate_storage_segment(workspace_id, "workspace id")?;
    let mut workspaces = load_workspaces()?;
    let original_len = workspaces.len();
    workspaces.retain(|workspace| workspace.id != workspace_id);
    if workspaces.len() == original_len {
        return Ok(false);
    }

    save_workspaces(&workspaces)?;

    let workspace_threads_dir = thread_workspace_dir(workspace_id)?;
    if workspace_threads_dir.exists() {
        fs::remove_dir_all(workspace_threads_dir)?;
    }

    Ok(true)
}

pub fn set_workspace_git_pull_on_master_for_new_threads(
    workspace_id: &str,
    enabled: bool,
) -> Result<Workspace> {
    let workspace_id = validate_storage_segment(workspace_id, "workspace id")?;
    let mut workspaces = load_workspaces()?;
    let workspace = workspaces
        .iter_mut()
        .find(|workspace| workspace.id == workspace_id)
        .ok_or_else(|| anyhow!("Workspace not found"))?;
    workspace.git_pull_on_master_for_new_threads = enabled;
    workspace.updated_at = Utc::now();
    let updated = workspace.clone();
    save_workspaces(&workspaces)?;
    Ok(updated)
}

pub fn set_workspace_order(workspace_ids: Vec<String>) -> Result<Vec<Workspace>> {
    let mut workspaces = load_workspaces()?;
    if workspaces.len() <= 1 {
        return Ok(workspaces);
    }

    let mut requested_ids = Vec::new();
    for workspace_id in workspace_ids {
        let normalized = validate_storage_segment(&workspace_id, "workspace id")?.to_string();
        if requested_ids
            .iter()
            .any(|existing: &String| existing == &normalized)
        {
            continue;
        }
        requested_ids.push(normalized);
    }

    if requested_ids.is_empty() {
        return Ok(workspaces);
    }

    let mut ordered = Vec::with_capacity(workspaces.len());
    for workspace_id in requested_ids {
        if let Some(index) = workspaces
            .iter()
            .position(|workspace| workspace.id == workspace_id)
        {
            ordered.push(workspaces.remove(index));
        }
    }
    ordered.extend(workspaces);
    save_workspaces(&ordered)?;
    Ok(ordered)
}

pub fn thread_workspace_dir(workspace_id: &str) -> Result<PathBuf> {
    let workspace_id = validate_storage_segment(workspace_id, "workspace id")?;
    Ok(ensure_base_dirs()?.join("threads").join(workspace_id))
}

pub fn thread_dir(workspace_id: &str, thread_id: &str) -> Result<PathBuf> {
    let thread_id = validate_storage_segment(thread_id, "thread id")?;
    Ok(thread_workspace_dir(workspace_id)?.join(thread_id))
}

pub fn runs_dir(workspace_id: &str, thread_id: &str) -> Result<PathBuf> {
    Ok(thread_dir(workspace_id, thread_id)?.join("runs"))
}

pub fn create_thread(workspace_id: &str, agent_id: Option<String>) -> Result<ThreadMetadata> {
    let now = Utc::now();
    let thread = ThreadMetadata {
        id: Uuid::new_v4().to_string(),
        workspace_id: workspace_id.to_string(),
        agent_id: agent_id.unwrap_or_else(|| "claude-code".to_string()),
        full_access: false,
        enabled_skills: Vec::new(),
        created_at: now,
        updated_at: now,
        title: "New thread".to_string(),
        is_archived: false,
        last_run_status: ThreadRunStatus::Idle,
        last_run_started_at: None,
        last_run_ended_at: None,
        claude_session_id: None,
        last_resume_at: None,
        last_new_session_at: None,
    };

    write_thread_metadata(&thread)?;
    let dir = thread_dir(workspace_id, &thread.id)?;
    fs::create_dir_all(dir.join("runs"))?;
    let transcript_path = dir.join("transcript.jsonl");
    if !transcript_path.exists() {
        File::create(transcript_path)?;
    }

    Ok(thread)
}

fn thread_metadata_path(workspace_id: &str, thread_id: &str) -> Result<PathBuf> {
    Ok(thread_dir(workspace_id, thread_id)?.join("thread.json"))
}

fn write_thread_metadata_unlocked(thread: &ThreadMetadata) -> Result<()> {
    let dir = thread_dir(&thread.workspace_id, &thread.id)?;
    fs::create_dir_all(&dir)?;
    let raw = serde_json::to_string_pretty(thread)?;
    write_file_atomic(
        &thread_metadata_path(&thread.workspace_id, &thread.id)?,
        raw.as_bytes(),
    )?;
    Ok(())
}

fn read_thread_metadata_unlocked(workspace_id: &str, thread_id: &str) -> Result<ThreadMetadata> {
    let raw = fs::read_to_string(thread_metadata_path(workspace_id, thread_id)?)?;
    Ok(serde_json::from_str(&raw)?)
}

fn mutate_thread_metadata<F>(
    workspace_id: &str,
    thread_id: &str,
    mutate: F,
) -> Result<ThreadMetadata>
where
    F: FnOnce(&mut ThreadMetadata) -> Result<()>,
{
    let _guard = thread_metadata_lock()
        .lock()
        .map_err(|_| anyhow!("Thread metadata lock poisoned"))?;
    let mut thread = read_thread_metadata_unlocked(workspace_id, thread_id)?;
    mutate(&mut thread)?;
    write_thread_metadata_unlocked(&thread)?;
    Ok(thread)
}

pub fn write_thread_metadata(thread: &ThreadMetadata) -> Result<()> {
    let _guard = thread_metadata_lock()
        .lock()
        .map_err(|_| anyhow!("Thread metadata lock poisoned"))?;
    write_thread_metadata_unlocked(thread)
}

pub fn read_thread_metadata(workspace_id: &str, thread_id: &str) -> Result<ThreadMetadata> {
    read_thread_metadata_unlocked(workspace_id, thread_id)
}

pub fn list_threads(workspace_id: &str) -> Result<Vec<ThreadMetadata>> {
    let base = thread_workspace_dir(workspace_id)?;
    if !base.exists() {
        return Ok(Vec::new());
    }

    let mut threads = Vec::new();
    for entry in fs::read_dir(base)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let metadata_path = path.join("thread.json");
        if !metadata_path.exists() {
            continue;
        }
        let raw = fs::read_to_string(metadata_path)?;
        let mut metadata: ThreadMetadata = serde_json::from_str(&raw)?;
        if metadata.is_archived {
            continue;
        }
        if matches!(metadata.last_run_status, ThreadRunStatus::Running) {
            metadata.last_run_status = ThreadRunStatus::Idle;
            let _ = write_thread_metadata(&metadata);
        }
        threads.push(metadata);
    }

    threads.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(threads)
}

pub fn set_thread_full_access(
    workspace_id: &str,
    thread_id: &str,
    full_access: bool,
) -> Result<ThreadMetadata> {
    mutate_thread_metadata(workspace_id, thread_id, |thread| {
        thread.full_access = full_access;
        thread.updated_at = Utc::now();
        Ok(())
    })
}

pub fn clear_thread_claude_session(workspace_id: &str, thread_id: &str) -> Result<ThreadMetadata> {
    mutate_thread_metadata(workspace_id, thread_id, |thread| {
        thread.claude_session_id = None;
        thread.updated_at = Utc::now();
        Ok(())
    })
}

pub fn set_thread_claude_session_id_if_missing(
    workspace_id: &str,
    thread_id: &str,
    claude_session_id: &str,
) -> Result<Option<ThreadMetadata>> {
    let normalized = claude_session_id.trim();
    if normalized.is_empty() {
        return Ok(None);
    }

    let _guard = thread_metadata_lock()
        .lock()
        .map_err(|_| anyhow!("Thread metadata lock poisoned"))?;
    let mut thread = read_thread_metadata_unlocked(workspace_id, thread_id)?;
    if thread.claude_session_id.is_some() {
        return Ok(None);
    }

    thread.claude_session_id = Some(normalized.to_string());
    thread.updated_at = Utc::now();
    write_thread_metadata_unlocked(&thread)?;
    Ok(Some(thread))
}

pub fn set_thread_skills(
    workspace_id: &str,
    thread_id: &str,
    enabled_skills: Vec<String>,
) -> Result<ThreadMetadata> {
    mutate_thread_metadata(workspace_id, thread_id, |thread| {
        thread.enabled_skills = enabled_skills;
        thread.updated_at = Utc::now();
        Ok(())
    })
}

pub fn set_thread_agent(
    workspace_id: &str,
    thread_id: &str,
    agent_id: String,
) -> Result<ThreadMetadata> {
    mutate_thread_metadata(workspace_id, thread_id, |thread| {
        thread.agent_id = agent_id;
        thread.updated_at = Utc::now();
        Ok(())
    })
}

pub fn rename_thread(workspace_id: &str, thread_id: &str, title: String) -> Result<ThreadMetadata> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("Thread title cannot be empty"));
    }
    mutate_thread_metadata(workspace_id, thread_id, |thread| {
        thread.title = trimmed.chars().take(80).collect();
        thread.updated_at = Utc::now();
        Ok(())
    })
}

pub fn archive_thread(workspace_id: &str, thread_id: &str) -> Result<ThreadMetadata> {
    mutate_thread_metadata(workspace_id, thread_id, |thread| {
        thread.is_archived = true;
        thread.updated_at = Utc::now();
        Ok(())
    })
}

pub fn delete_thread(workspace_id: &str, thread_id: &str) -> Result<()> {
    let path = thread_dir(workspace_id, thread_id)?;
    if !path.exists() {
        return Ok(());
    }
    let trash_dir = thread_workspace_dir(workspace_id)?.join(".trash");
    fs::create_dir_all(&trash_dir)?;
    let tombstone = trash_dir.join(format!("{thread_id}-{}", Uuid::new_v4()));

    if fs::rename(&path, &tombstone).is_ok() {
        std::thread::spawn(move || {
            let _ = fs::remove_dir_all(tombstone);
        });
        return Ok(());
    }

    fs::remove_dir_all(path)?;
    Ok(())
}

pub fn set_thread_run_state(
    workspace_id: &str,
    thread_id: &str,
    status: ThreadRunStatus,
    started_at: Option<chrono::DateTime<Utc>>,
    ended_at: Option<chrono::DateTime<Utc>>,
) -> Result<ThreadMetadata> {
    mutate_thread_metadata(workspace_id, thread_id, |thread| {
        thread.last_run_status = status;
        if started_at.is_some() {
            thread.last_run_started_at = started_at;
        }
        if ended_at.is_some() {
            thread.last_run_ended_at = ended_at;
        }
        thread.updated_at = Utc::now();
        Ok(())
    })
}

fn transcript_path(workspace_id: &str, thread_id: &str) -> Result<PathBuf> {
    Ok(thread_dir(workspace_id, thread_id)?.join("transcript.jsonl"))
}

pub fn append_transcript_entry(
    workspace_id: &str,
    thread_id: &str,
    entry: &TranscriptEntry,
) -> Result<()> {
    let path = transcript_path(workspace_id, thread_id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    if !path.exists() {
        File::create(&path)?;
    }
    let mut file = OpenOptions::new().append(true).open(path)?;
    let serialized = serde_json::to_string(entry)?;
    writeln!(file, "{serialized}")?;

    mutate_thread_metadata(workspace_id, thread_id, |thread| {
        thread.updated_at = Utc::now();
        if entry.role == "user" {
            let first_line = entry.content.lines().next().unwrap_or("New thread").trim();
            if thread.title == "New thread" && !first_line.is_empty() {
                thread.title = first_line.chars().take(50).collect();
            }
        }
        Ok(())
    })?;
    Ok(())
}

pub fn load_transcript(workspace_id: &str, thread_id: &str) -> Result<Vec<TranscriptEntry>> {
    let path = transcript_path(workspace_id, thread_id)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let file = File::open(path)?;
    let reader = BufReader::new(file);
    let mut entries = Vec::new();
    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let entry: TranscriptEntry = serde_json::from_str(&line)?;
        entries.push(entry);
    }
    Ok(entries)
}

pub fn append_user_message(
    workspace_id: &str,
    thread_id: &str,
    content: &str,
) -> Result<TranscriptEntry> {
    let entry = TranscriptEntry {
        id: Uuid::new_v4().to_string(),
        role: "user".to_string(),
        content: content.to_string(),
        created_at: Utc::now(),
        run_id: None,
    };
    append_transcript_entry(workspace_id, thread_id, &entry)?;
    Ok(entry)
}

pub fn resolve_workspace_id_by_path(workspace_path: &str) -> Result<Option<String>> {
    let canonical = fs::canonicalize(workspace_path)
        .unwrap_or_else(|_| Path::new(workspace_path).to_path_buf())
        .to_string_lossy()
        .to_string();
    let workspaces = load_workspaces()?;
    Ok(workspaces
        .iter()
        .find(|workspace| workspace.path == canonical)
        .map(|workspace| workspace.id.clone()))
}

pub fn resolve_workspace_by_path(workspace_path: &str) -> Result<Option<Workspace>> {
    let canonical = fs::canonicalize(workspace_path)
        .unwrap_or_else(|_| Path::new(workspace_path).to_path_buf())
        .to_string_lossy()
        .to_string();
    let workspaces = load_workspaces()?;
    Ok(workspaces
        .iter()
        .find(|workspace| workspace.path == canonical)
        .cloned())
}

pub fn write_json_file<T: serde::Serialize>(path: &Path, value: &T) -> Result<()> {
    let raw = serde_json::to_string_pretty(value)?;
    write_file_atomic(path, raw.as_bytes())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    fn test_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn add_workspace_persists_across_loads() {
        let _guard = test_lock().lock().expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!("claude-desk-test-{}", Uuid::new_v4()));
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("failed to create workspace fixture");

        std::env::set_var("CLAUDE_DESK_APP_SUPPORT_ROOT", &temp_root);

        let added = add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be added");
        let first_load = load_workspaces().expect("workspaces should load");
        let second_load = load_workspaces().expect("workspaces should load after reload");

        assert_eq!(first_load.len(), 1);
        assert_eq!(second_load.len(), 1);
        assert_eq!(first_load[0].id, added.id);
        assert_eq!(first_load[0].path, second_load[0].path);

        std::env::remove_var("CLAUDE_DESK_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn add_rdev_workspace_persists_command_and_kind() {
        let _guard = test_lock().lock().expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "claude-desk-rdev-workspace-test-{}",
            Uuid::new_v4()
        ));
        std::env::set_var("CLAUDE_DESK_APP_SUPPORT_ROOT", &temp_root);

        let added = add_rdev_workspace(
            "rdev ssh comms-ai-open-connect/offbeat-apple",
            Some("offbeat-apple"),
        )
        .expect("rdev workspace should be added");
        assert_eq!(added.kind, WorkspaceKind::Rdev);
        assert_eq!(
            added.rdev_ssh_command.as_deref(),
            Some("rdev ssh comms-ai-open-connect/offbeat-apple")
        );
        assert!(
            added.path.starts_with("rdev-workspace-"),
            "rdev workspace path should use deterministic non-filesystem marker"
        );

        let loaded = load_workspaces().expect("workspaces should load");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, added.id);
        assert_eq!(loaded[0].kind, WorkspaceKind::Rdev);

        std::env::remove_var("CLAUDE_DESK_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn remove_workspace_prunes_registry_and_thread_storage() {
        let _guard = test_lock().lock().expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "claude-desk-remove-workspace-test-{}",
            Uuid::new_v4()
        ));
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("failed to create workspace fixture");

        std::env::set_var("CLAUDE_DESK_APP_SUPPORT_ROOT", &temp_root);

        let workspace = add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be added");
        let thread = create_thread(&workspace.id, Some("claude-code".to_string()))
            .expect("thread should be created");
        let thread_storage_dir =
            thread_dir(&workspace.id, &thread.id).expect("thread dir should resolve");
        assert!(
            thread_storage_dir.exists(),
            "thread storage should exist before workspace removal"
        );

        let removed = remove_workspace(&workspace.id).expect("workspace removal should succeed");
        assert!(removed, "workspace should report removed");
        assert!(
            !thread_workspace_dir(&workspace.id)
                .expect("workspace dir should resolve")
                .exists(),
            "workspace thread storage should be deleted"
        );

        let remaining = load_workspaces().expect("workspaces should still load");
        assert!(remaining.is_empty(), "workspace registry should be empty");

        std::env::remove_var("CLAUDE_DESK_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn full_access_persists_per_thread() {
        let _guard = test_lock().lock().expect("lock poisoned");

        let temp_root =
            std::env::temp_dir().join(format!("claude-desk-thread-test-{}", Uuid::new_v4()));
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("failed to create workspace fixture");

        std::env::set_var("CLAUDE_DESK_APP_SUPPORT_ROOT", &temp_root);

        let workspace = add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be added");
        let thread = create_thread(&workspace.id, Some("claude-code".to_string()))
            .expect("thread should be created");

        let updated = set_thread_full_access(&workspace.id, &thread.id, true)
            .expect("full access should update");
        assert!(updated.full_access);

        let reloaded =
            read_thread_metadata(&workspace.id, &thread.id).expect("thread should reload");
        assert!(reloaded.full_access);

        std::env::remove_var("CLAUDE_DESK_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn claude_session_id_persists_per_thread() {
        let _guard = test_lock().lock().expect("lock poisoned");

        let temp_root =
            std::env::temp_dir().join(format!("claude-desk-session-test-{}", Uuid::new_v4()));
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("failed to create workspace fixture");

        std::env::set_var("CLAUDE_DESK_APP_SUPPORT_ROOT", &temp_root);

        let workspace = add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be added");
        let thread = create_thread(&workspace.id, Some("claude-code".to_string()))
            .expect("thread should be created");

        let captured = set_thread_claude_session_id_if_missing(
            &workspace.id,
            &thread.id,
            "123e4567-e89b-12d3-a456-426614174000",
        )
        .expect("session id should persist")
        .expect("thread should update");
        assert_eq!(
            captured.claude_session_id.as_deref(),
            Some("123e4567-e89b-12d3-a456-426614174000")
        );

        let duplicate = set_thread_claude_session_id_if_missing(
            &workspace.id,
            &thread.id,
            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        )
        .expect("duplicate capture should not error");
        assert!(
            duplicate.is_none(),
            "capture should not overwrite existing session id"
        );

        let reloaded =
            read_thread_metadata(&workspace.id, &thread.id).expect("thread should reload");
        assert_eq!(
            reloaded.claude_session_id.as_deref(),
            Some("123e4567-e89b-12d3-a456-426614174000")
        );

        let cleared =
            clear_thread_claude_session(&workspace.id, &thread.id).expect("clear should succeed");
        assert!(cleared.claude_session_id.is_none());

        std::env::remove_var("CLAUDE_DESK_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn rejects_invalid_thread_path_segments() {
        let _guard = test_lock().lock().expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "claude-desk-invalid-thread-id-test-{}",
            Uuid::new_v4()
        ));
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("failed to create workspace fixture");

        std::env::set_var("CLAUDE_DESK_APP_SUPPORT_ROOT", &temp_root);
        let workspace = add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be added");

        let error = read_thread_metadata(&workspace.id, "../escape")
            .expect_err("invalid thread id should fail");
        assert!(
            error.to_string().contains("Invalid thread id"),
            "unexpected error: {error}"
        );

        std::env::remove_var("CLAUDE_DESK_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn set_thread_claude_session_id_is_atomic_across_threads() {
        let _guard = test_lock().lock().expect("lock poisoned");

        let temp_root =
            std::env::temp_dir().join(format!("claude-desk-session-race-test-{}", Uuid::new_v4()));
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("failed to create workspace fixture");

        std::env::set_var("CLAUDE_DESK_APP_SUPPORT_ROOT", &temp_root);

        let workspace = add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be added");
        let thread = create_thread(&workspace.id, Some("claude-code".to_string()))
            .expect("thread should be created");

        let mut handles = Vec::new();
        for _ in 0..8 {
            let workspace_id = workspace.id.clone();
            let thread_id = thread.id.clone();
            let session_candidate = Uuid::new_v4().to_string();
            handles.push(std::thread::spawn(move || {
                set_thread_claude_session_id_if_missing(
                    &workspace_id,
                    &thread_id,
                    &session_candidate,
                )
                .expect("capture should not fail")
                .and_then(|metadata| metadata.claude_session_id)
            }));
        }

        let mut captured = Vec::new();
        for handle in handles {
            if let Some(session_id) = handle.join().expect("capture worker panicked") {
                captured.push(session_id);
            }
        }

        assert_eq!(
            captured.len(),
            1,
            "exactly one concurrent capture should succeed"
        );
        let stored = read_thread_metadata(&workspace.id, &thread.id)
            .expect("thread should reload")
            .claude_session_id
            .expect("session id should be stored");
        assert_eq!(stored, captured[0]);

        std::env::remove_var("CLAUDE_DESK_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }
}
