use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Result};
use chrono::Utc;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

use crate::git_tools;
use crate::models::{
    ContextFilePreview, ContextPreview, RunClaudeRequest, RunClaudeResponse, RunExitEvent, RunMetadata, Settings,
    StreamEvent, TerminalDataEvent, TerminalExitEvent, TerminalStartResponse, ThreadRunStatus, TranscriptEntry,
};
use crate::skills;
use crate::storage;

const STREAM_EVENT: &str = "claude://run-stream";
const EXIT_EVENT: &str = "claude://run-exit";
const TERMINAL_DATA_EVENT: &str = "terminal:data";
const TERMINAL_EXIT_EVENT: &str = "terminal:exit";

pub type TerminalSessionId = String;

struct TerminalSession {
    session_id: TerminalSessionId,
    workspace_id: String,
    workspace_path: String,
    thread_id: String,
    started_at: chrono::DateTime<Utc>,
    command: Vec<String>,
    output_log_path: PathBuf,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send>>>,
}

#[derive(Default)]
pub struct TerminalSessionManager {
    sessions: Mutex<HashMap<TerminalSessionId, Arc<TerminalSession>>>,
}

impl TerminalSessionManager {
    fn insert(&self, session: Arc<TerminalSession>) -> Result<()> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("Terminal session lock poisoned"))?;
        sessions.insert(session.session_id.clone(), session);
        Ok(())
    }

    fn get(&self, session_id: &str) -> Result<Option<Arc<TerminalSession>>> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("Terminal session lock poisoned"))?;
        Ok(sessions.get(session_id).cloned())
    }

    fn remove(&self, session_id: &str) -> Result<Option<Arc<TerminalSession>>> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("Terminal session lock poisoned"))?;
        Ok(sessions.remove(session_id))
    }

    pub fn shutdown_all(&self) {
        let sessions = match self.sessions.lock() {
            Ok(guard) => guard.values().cloned().collect::<Vec<_>>(),
            Err(_) => return,
        };
        for session in sessions {
            if let Ok(mut child) = session.child.lock() {
                let _ = child.kill();
            }
        }
    }
}

#[derive(Default)]
pub struct RunnerState {
    pub processes: AsyncMutex<HashMap<String, Arc<AsyncMutex<Child>>>>,
    pub terminal_sessions: TerminalSessionManager,
}

pub fn detect_claude_cli_path(settings: &Settings) -> Option<String> {
    if let Some(path) = &settings.claude_cli_path {
        if Path::new(path).exists() {
            return Some(path.clone());
        }
    }

    let mut candidates = vec!["/usr/local/bin/claude".to_string(), "/opt/homebrew/bin/claude".to_string()];
    if let Some(home) = dirs::home_dir().map(|dir| dir.to_string_lossy().to_string()) {
        candidates.push(format!("{home}/.volta/bin/claude"));
        candidates.push(format!("{home}/.npm-global/bin/claude"));
        candidates.push(format!("{home}/.local/bin/claude"));
    }

    for path in candidates {
        if Path::new(&path).exists() {
            return Some(path);
        }
    }

    if let Ok(output) = std::process::Command::new("which").arg("claude").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() && Path::new(&path).exists() {
                return Some(path);
            }
        }
    }

    None
}

fn decode_utf8_chunk(buffer: &[u8], carry: &mut Vec<u8>) -> Option<String> {
    carry.extend_from_slice(buffer);
    if carry.is_empty() {
        return None;
    }

    let mut output = String::new();

    loop {
        match std::str::from_utf8(carry) {
            Ok(text) => {
                output.push_str(text);
                carry.clear();
                break;
            }
            Err(error) => {
                let valid = error.valid_up_to();
                if valid > 0 {
                    if let Ok(text) = std::str::from_utf8(&carry[..valid]) {
                        output.push_str(text);
                    }
                }

                match error.error_len() {
                    Some(error_len) => {
                        // Replace invalid UTF-8 runes while preserving stream continuity.
                        output.push('\u{fffd}');
                        let drain = valid.saturating_add(error_len);
                        carry.drain(..drain);
                        if carry.is_empty() {
                            break;
                        }
                    }
                    None => {
                        // Incomplete UTF-8 sequence at chunk boundary: keep bytes for next read.
                        carry.drain(..valid);
                        break;
                    }
                }
            }
        }
    }

    if output.is_empty() {
        None
    } else {
        Some(output)
    }
}

pub fn build_context_preview(workspace_path: &str, context_pack: &str) -> Result<ContextPreview> {
    match context_pack.to_lowercase().as_str() {
        "git diff" | "gitdiff" | "git_diff" => build_git_diff_context(workspace_path),
        "debug" => build_debug_context(workspace_path),
        _ => Ok(ContextPreview {
            files: vec![],
            total_size: 0,
            context_text: String::new(),
        }),
    }
}

fn build_git_diff_context(workspace_path: &str) -> Result<ContextPreview> {
    let summary = git_tools::get_git_diff_summary(workspace_path)?;
    let stat = summary.stat;
    let diff = summary.diff_excerpt;

    let files = vec![
        ContextFilePreview {
            path: "git.diff.stat".to_string(),
            size: stat.len(),
        },
        ContextFilePreview {
            path: "git.diff.patch".to_string(),
            size: diff.len(),
        },
    ];
    let total_size = stat.len() + diff.len();
    let context_text = format!(
        "## Git Diff Summary\n{}\n\n## Git Diff\n{}",
        if stat.is_empty() { "(No changes)" } else { &stat },
        if diff.is_empty() {
            "(No diff output)"
        } else {
            &diff
        }
    );

    Ok(ContextPreview {
        files,
        total_size,
        context_text,
    })
}

fn build_debug_context(workspace_path: &str) -> Result<ContextPreview> {
    let mut files = Vec::new();
    let mut context_parts = Vec::new();
    let mut total_size = 0usize;

    let logs_dir = Path::new(workspace_path).join("logs");
    if logs_dir.exists() {
        for entry in fs::read_dir(logs_dir)? {
            let entry = entry?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if !looks_like_log(&path) {
                continue;
            }

            let content = fs::read_to_string(&path).unwrap_or_default();
            let max = 8_000;
            let trimmed = if content.len() > max {
                content.chars().rev().take(max).collect::<String>().chars().rev().collect()
            } else {
                content
            };
            let file_name = path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| "log.txt".to_string());
            total_size += trimmed.len();
            files.push(ContextFilePreview {
                path: format!("logs/{file_name}"),
                size: trimmed.len(),
            });
            context_parts.push(format!("## {file_name}\n{trimmed}"));

            if files.len() >= 5 {
                break;
            }
        }
    }

    Ok(ContextPreview {
        files,
        total_size,
        context_text: context_parts.join("\n\n"),
    })
}

fn looks_like_log(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| matches!(ext, "log" | "txt" | "out"))
        .unwrap_or(false)
}

pub async fn cancel_run(state: Arc<RunnerState>, run_id: String) -> Result<bool> {
    let child_handle = {
        let processes = state.processes.lock().await;
        processes.get(&run_id).cloned()
    };

    if let Some(child_handle) = child_handle {
        let mut child = child_handle.lock().await;
        child.kill().await?;
        return Ok(true);
    }

    if let Some(session) = state.terminal_sessions.get(&run_id)? {
        if let Ok(mut child) = session.child.lock() {
            child.kill()?;
            return Ok(true);
        }
    }

    Ok(false)
}

pub fn terminal_get_last_log(workspace_id: &str, thread_id: &str) -> Result<String> {
    let runs_root = storage::runs_dir(workspace_id, thread_id)?;
    if !runs_root.exists() {
        return Ok(String::new());
    }

    let mut logs: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for entry in fs::read_dir(&runs_root)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let output_log = path.join("output.log");
        if !output_log.exists() {
            continue;
        }
        let modified = fs::metadata(&output_log)
            .and_then(|metadata| metadata.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        logs.push((modified, output_log));
    }

    logs.sort_by(|a, b| a.0.cmp(&b.0));
    let Some((_, last_log)) = logs.last() else {
        return Ok(String::new());
    };

    let bytes = fs::read(last_log)?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

pub fn terminal_read_output(state: Arc<RunnerState>, session_id: String) -> Result<String> {
    let Some(session) = state.terminal_sessions.get(&session_id)? else {
        return Err(anyhow!("Terminal session not found"));
    };

    let bytes = fs::read(&session.output_log_path)?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

pub async fn terminal_start_session(
    app: AppHandle,
    state: Arc<RunnerState>,
    workspace_path: String,
    initial_cwd: Option<String>,
    env_vars: Option<HashMap<String, String>>,
    full_access_flag: bool,
    thread_id: String,
) -> Result<TerminalStartResponse> {
    let workspace_id = storage::resolve_workspace_id_by_path(&workspace_path)?
        .ok_or_else(|| anyhow!("Workspace not registered. Add workspace before starting terminal."))?;

    let mut thread = storage::read_thread_metadata(&workspace_id, &thread_id)?;
    if thread.full_access != full_access_flag {
        thread.full_access = full_access_flag;
        storage::write_thread_metadata(&thread)?;
    }
    let _ = storage::set_thread_run_state(
        &workspace_id,
        &thread_id,
        ThreadRunStatus::Running,
        Some(Utc::now()),
        None,
    );

    let settings = storage::load_settings()?;
    let cli_path = detect_claude_cli_path(&settings)
        .ok_or_else(|| anyhow!("Claude CLI not found. Configure the CLI path in Settings."))?;

    let cwd = initial_cwd.unwrap_or_else(|| workspace_path.clone());
    let session_id = Uuid::new_v4().to_string();
    let run_dir = storage::runs_dir(&workspace_id, &thread_id)?.join(&session_id);
    fs::create_dir_all(&run_dir)?;

    let mut args = Vec::new();
    if full_access_flag {
        args.push("--dangerously-skip-permissions".to_string());
    }

    let started_at = Utc::now();
    let command_manifest = [vec![cli_path.clone()], args.clone()].concat();
    storage::write_json_file(
        &run_dir.join("input_manifest.json"),
        &serde_json::json!({
            "sessionId": session_id,
            "threadId": thread_id,
            "workspacePath": workspace_path,
            "workspaceId": workspace_id,
            "fullAccess": full_access_flag,
            "cwd": cwd,
            "envVars": env_vars,
            "command": command_manifest,
            "startedAt": started_at,
            "mode": "interactive-terminal"
        }),
    )?;

    let pty_system = native_pty_system();
    let pty_pair = pty_system.openpty(PtySize {
        rows: 32,
        cols: 120,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let mut command = CommandBuilder::new(cli_path.clone());
    for arg in &args {
        command.arg(arg);
    }
    command.cwd(cwd.clone());
    command.env("TERM", "xterm-256color");
    if let Some(extra_env) = &env_vars {
        for (key, value) in extra_env {
            command.env(key, value);
        }
    }

    let child = pty_pair.slave.spawn_command(command)?;
    let mut reader = pty_pair.master.try_clone_reader()?;
    let writer = pty_pair.master.take_writer()?;
    let output_log_path = run_dir.join("output.log");
    let output_log = Arc::new(Mutex::new(
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&output_log_path)?,
    ));

    let session = Arc::new(TerminalSession {
        session_id: session_id.clone(),
        workspace_id: workspace_id.clone(),
        workspace_path: workspace_path.clone(),
        thread_id: thread_id.clone(),
        started_at,
        command: command_manifest.clone(),
        output_log_path,
        master: Arc::new(Mutex::new(pty_pair.master)),
        writer: Arc::new(Mutex::new(writer)),
        child: Arc::new(Mutex::new(child)),
    });
    state.terminal_sessions.insert(session.clone())?;

    let data_session_id = session_id.clone();
    let data_output_log = output_log.clone();
    let data_app = app.clone();
    std::thread::spawn(move || {
        let mut buffer = [0u8; 4096];
        let mut utf8_carry = Vec::<u8>::new();
        loop {
            let read = match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => size,
                Err(_) => break,
            };

            if let Ok(mut file) = data_output_log.lock() {
                let _ = file.write_all(&buffer[..read]);
            }

            if let Some(chunk) = decode_utf8_chunk(&buffer[..read], &mut utf8_carry) {
                let _ = data_app.emit(
                    TERMINAL_DATA_EVENT,
                    TerminalDataEvent {
                        session_id: data_session_id.clone(),
                        data: chunk,
                    },
                );
            }
        }

        if !utf8_carry.is_empty() {
            let chunk = String::from_utf8_lossy(&utf8_carry).to_string();
            let _ = data_app.emit(
                TERMINAL_DATA_EVENT,
                TerminalDataEvent {
                    session_id: data_session_id.clone(),
                    data: chunk,
                },
            );
        }
    });

    let wait_state = state.clone();
    let wait_session = session.clone();
    let wait_session_id = session_id.clone();
    std::thread::spawn(move || {
        let (code, signal) = {
            let mut child = match wait_session.child.lock() {
                Ok(child) => child,
                Err(_) => return,
            };
            match child.wait() {
                Ok(status) => {
                    (Some(status.exit_code() as i32), None)
                }
                Err(_) => (None, None),
            }
        };

        let _ = wait_state.terminal_sessions.remove(&wait_session_id);

        let ended_at = Utc::now();
        let duration_ms = (ended_at - wait_session.started_at).num_milliseconds();
        let run_folder = storage::runs_dir(&wait_session.workspace_id, &wait_session.thread_id)
            .unwrap_or_else(|_| PathBuf::from(""))
            .join(&wait_session_id);

        let _ = storage::write_json_file(
            &run_folder.join("metadata.json"),
            &serde_json::json!({
                "sessionId": wait_session_id,
                "threadId": wait_session.thread_id,
                "workspaceId": wait_session.workspace_id,
                "command": wait_session.command,
                "durationMs": duration_ms,
                "exitCode": code,
                "signal": signal,
                "startedAt": wait_session.started_at,
                "endedAt": ended_at,
                "rawOutputLogPath": wait_session.output_log_path,
                "userInputsLogPath": serde_json::Value::Null,
                "outputLogPath": wait_session.output_log_path,
            }),
        );

        let status = if signal.is_some() || code == Some(130) {
            ThreadRunStatus::Canceled
        } else if code == Some(0) {
            ThreadRunStatus::Succeeded
        } else {
            ThreadRunStatus::Failed
        };
        let _ = storage::set_thread_run_state(
            &wait_session.workspace_id,
            &wait_session.thread_id,
            status,
            None,
            Some(ended_at),
        );

        if let Ok(diff) = git_tools::capture_patch_diff(&wait_session.workspace_path) {
            let _ = fs::write(run_folder.join("patch.diff"), diff);
        }

        let _ = app.emit(
            TERMINAL_EXIT_EVENT,
            TerminalExitEvent {
                session_id: wait_session_id,
                code,
                signal,
            },
        );
    });

    Ok(TerminalStartResponse { session_id })
}

pub fn terminal_write(state: Arc<RunnerState>, session_id: String, data: String) -> Result<bool> {
    let Some(session) = state.terminal_sessions.get(&session_id)? else {
        return Ok(false);
    };

    let mut writer = session
        .writer
        .lock()
        .map_err(|_| anyhow!("Terminal writer lock poisoned"))?;
    writer.write_all(data.as_bytes())?;
    writer.flush()?;
    Ok(true)
}

pub fn terminal_resize(state: Arc<RunnerState>, session_id: String, cols: u16, rows: u16) -> Result<bool> {
    let Some(session) = state.terminal_sessions.get(&session_id)? else {
        return Ok(false);
    };

    let clamped_cols = cols.clamp(20, 400);
    let clamped_rows = rows.clamp(8, 240);
    let master = session
        .master
        .lock()
        .map_err(|_| anyhow!("Terminal master lock poisoned"))?;
    master.resize(PtySize {
        cols: clamped_cols,
        rows: clamped_rows,
        pixel_width: 0,
        pixel_height: 0,
    })?;
    Ok(true)
}

pub fn terminal_kill(state: Arc<RunnerState>, session_id: String) -> Result<bool> {
    let Some(session) = state.terminal_sessions.get(&session_id)? else {
        return Ok(false);
    };

    let mut child = session
        .child
        .lock()
        .map_err(|_| anyhow!("Terminal child lock poisoned"))?;
    child.kill()?;
    Ok(true)
}

pub fn terminal_send_signal(state: Arc<RunnerState>, session_id: String, signal: String) -> Result<bool> {
    let normalized = signal.trim().to_uppercase();
    if normalized != "SIGINT" && normalized != "INT" {
        return Err(anyhow!("Only SIGINT is currently supported"));
    }

    let Some(session) = state.terminal_sessions.get(&session_id)? else {
        return Ok(false);
    };

    let pid = {
        let child = session
            .child
            .lock()
            .map_err(|_| anyhow!("Terminal child lock poisoned"))?;
        child.process_id()
    };

    if let Some(pid) = pid {
        let result = unsafe { libc::kill(pid as i32, libc::SIGINT) };
        if result == 0 {
            return Ok(true);
        }
    }

    terminal_write(state, session_id, "\u{3}".to_string())
}

pub async fn run_claude(
    app: AppHandle,
    state: Arc<RunnerState>,
    request: RunClaudeRequest,
) -> Result<RunClaudeResponse> {
    let workspace_id = storage::resolve_workspace_id_by_path(&request.workspace_path)?
        .ok_or_else(|| anyhow!("Workspace not registered. Add workspace before running Claude."))?;

    let mut thread = storage::read_thread_metadata(&workspace_id, &request.thread_id)?;
    if thread.full_access != request.full_access {
        thread.full_access = request.full_access;
        storage::write_thread_metadata(&thread)?;
    }

    let settings = storage::load_settings()?;
    let cli_path = detect_claude_cli_path(&settings)
        .ok_or_else(|| anyhow!("Claude CLI not found. Configure the CLI path in Settings."))?;

    let context_preview = build_context_preview(&request.workspace_path, &request.context_pack)?;
    let enabled_skill_docs = skills::resolve_enabled_skills_context(&request.workspace_path, &request.enabled_skills)?;
    let prompt = build_prompt(&request.message, &context_preview.context_text, &enabled_skill_docs);

    let run_id = Uuid::new_v4().to_string();
    let run_dir = storage::runs_dir(&workspace_id, &request.thread_id)?.join(&run_id);
    fs::create_dir_all(&run_dir)?;

    let mut args = vec!["-p".to_string(), prompt.clone()];
    if request.full_access {
        args.push("--dangerously-skip-permissions".to_string());
    }

    let mut command = Command::new(&cli_path);
    command
        .args(&args)
        .current_dir(&request.workspace_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let command_manifest = [vec![cli_path.clone()], args.clone()].concat();
    let started_at = Utc::now();
    storage::write_json_file(
        &run_dir.join("input_manifest.json"),
        &serde_json::json!({
            "runId": run_id,
            "threadId": request.thread_id,
            "workspacePath": request.workspace_path,
            "workspaceId": workspace_id,
            "message": request.message,
            "enabledSkills": request.enabled_skills,
            "fullAccess": request.full_access,
            "contextPack": request.context_pack,
            "command": command_manifest,
            "startedAt": started_at,
        }),
    )?;

    let mut child = command.spawn()?;
    let stdout = child.stdout.take().ok_or_else(|| anyhow!("Failed to capture Claude stdout"))?;
    let stderr = child.stderr.take().ok_or_else(|| anyhow!("Failed to capture Claude stderr"))?;

    let child_handle = Arc::new(AsyncMutex::new(child));
    {
        let mut processes = state.processes.lock().await;
        processes.insert(run_id.clone(), child_handle.clone());
    }

    let output_log = Arc::new(Mutex::new(
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(run_dir.join("output.log"))?,
    ));
    let assistant_output = Arc::new(AsyncMutex::new(String::new()));

    let stdout_task = spawn_stream_reader(
        app.clone(),
        run_id.clone(),
        request.thread_id.clone(),
        "stdout".to_string(),
        stdout,
        output_log.clone(),
        assistant_output.clone(),
    );

    let stderr_task = spawn_stream_reader(
        app.clone(),
        run_id.clone(),
        request.thread_id.clone(),
        "stderr".to_string(),
        stderr,
        output_log,
        assistant_output.clone(),
    );

    let wait_state = state.clone();
    let wait_workspace_id = workspace_id.clone();
    let wait_thread_id = request.thread_id.clone();
    let wait_workspace_path = request.workspace_path.clone();
    let wait_run_id = run_id.clone();
    let wait_args = args.clone();

    tokio::spawn(async move {
        let status_result = {
            let mut child = child_handle.lock().await;
            child.wait().await
        };

        let _ = stdout_task.await;
        let _ = stderr_task.await;

        {
            let mut processes = wait_state.processes.lock().await;
            processes.remove(&wait_run_id);
        }

        let ended_at = Utc::now();
        let duration_ms = (ended_at - started_at).num_milliseconds();

        let exit_code = status_result.ok().and_then(|status| status.code());

        let command_vec = [vec![cli_path], wait_args].concat();
        let metadata = RunMetadata {
            run_id: wait_run_id.clone(),
            thread_id: wait_thread_id.clone(),
            workspace_id: wait_workspace_id.clone(),
            started_at,
            ended_at,
            duration_ms,
            exit_code,
            command: command_vec.clone(),
        };

        let run_folder: PathBuf = storage::runs_dir(&wait_workspace_id, &wait_thread_id)
            .unwrap_or_else(|_| PathBuf::from(""))
            .join(&wait_run_id);

        let _ = storage::write_json_file(
            &run_folder.join("metadata.json"),
            &serde_json::json!({
                "runId": wait_run_id,
                "threadId": wait_thread_id,
                "workspaceId": wait_workspace_id,
                "command": command_vec,
                "durationMs": duration_ms,
                "exitCode": exit_code,
                "startedAt": started_at,
                "endedAt": ended_at,
            }),
        );

        if let Ok(diff) = git_tools::capture_patch_diff(&wait_workspace_path) {
            let _ = fs::write(run_folder.join("patch.diff"), diff);
        }

        let output = assistant_output.lock().await.clone();
        if !output.trim().is_empty() {
            let entry = TranscriptEntry {
                id: Uuid::new_v4().to_string(),
                role: "assistant".to_string(),
                content: output,
                created_at: Utc::now(),
                run_id: Some(metadata.run_id.clone()),
            };
            let _ = storage::append_transcript_entry(&metadata.workspace_id, &metadata.thread_id, &entry);
        }

        let _ = app.emit(
            EXIT_EVENT,
            RunExitEvent {
                run_id: metadata.run_id,
                thread_id: metadata.thread_id,
                exit_code: metadata.exit_code,
                duration_ms,
            },
        );
    });

    Ok(RunClaudeResponse { run_id })
}

fn build_prompt(message: &str, context_text: &str, enabled_skills: &[(String, String)]) -> String {
    let mut sections = Vec::new();

    if !enabled_skills.is_empty() {
        let mut skills_section = String::from("## Enabled Skills\n");
        for (skill_name, content) in enabled_skills {
            skills_section.push_str(&format!("\n### Skill: {skill_name}\n{content}\n"));
        }
        sections.push(skills_section);
    }

    if !context_text.trim().is_empty() {
        sections.push(format!("## Context Pack\n{context_text}"));
    }

    sections.push(format!("## User Request\n{message}"));
    sections.join("\n\n")
}

fn spawn_stream_reader<R>(
    app: AppHandle,
    run_id: String,
    thread_id: String,
    stream: String,
    reader: R,
    output_file: Arc<Mutex<std::fs::File>>,
    assistant_output: Arc<AsyncMutex<String>>,
) -> tokio::task::JoinHandle<()>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let chunk = format!("{line}\n");

            if let Ok(mut file) = output_file.lock() {
                let _ = file.write_all(chunk.as_bytes());
            }

            {
                let mut output = assistant_output.lock().await;
                output.push_str(&chunk);
            }

            let event = StreamEvent {
                run_id: run_id.clone(),
                thread_id: thread_id.clone(),
                stream: stream.clone(),
                chunk,
            };
            let _ = app.emit(STREAM_EVENT, event);
        }
    })
}

pub async fn generate_commit_message(workspace_path: String, full_access: bool) -> Result<String> {
    let settings = storage::load_settings()?;
    let cli_path = detect_claude_cli_path(&settings)
        .ok_or_else(|| anyhow!("Claude CLI not found. Configure the CLI path in Settings."))?;

    let diff_summary = git_tools::get_git_diff_summary(&workspace_path)?;

    let prompt = format!(
        "You are generating a single concise git commit message. Use imperative mood.\n\nGit diff stat:\n{}\n\nGit diff:\n{}\n\nReturn only the commit message.",
        if diff_summary.stat.is_empty() {
            "(No changes detected)"
        } else {
            &diff_summary.stat
        },
        if diff_summary.diff_excerpt.is_empty() {
            "(No diff)"
        } else {
            &diff_summary.diff_excerpt
        }
    );

    let mut args = vec!["-p", &prompt];
    if full_access {
        args.push("--dangerously-skip-permissions");
    }

    let output = Command::new(cli_path)
        .args(args)
        .current_dir(workspace_path)
        .output()
        .await?;

    if !output.status.success() {
        return Err(anyhow!(
            "Claude failed to generate commit message: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}
