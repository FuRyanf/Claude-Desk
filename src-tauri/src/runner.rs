use std::collections::HashMap;
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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
    ContextFilePreview, ContextPreview, RunClaudeRequest, RunClaudeResponse, RunExitEvent,
    RunMetadata, Settings, StreamEvent, TerminalDataEvent, TerminalExitEvent,
    TerminalStartResponse, ThreadRunStatus, TranscriptEntry, WorkspaceKind,
};
use crate::skills;
use crate::storage;

const STREAM_EVENT: &str = "claude://run-stream";
const EXIT_EVENT: &str = "claude://run-exit";
const TERMINAL_DATA_EVENT: &str = "terminal:data";
const TERMINAL_EXIT_EVENT: &str = "terminal:exit";
const THREAD_UPDATED_EVENT: &str = "thread:updated";
const SESSION_ID_PARSE_BUFFER_MAX: usize = 24 * 1024;
const POST_CONNECT_PROMPT_BUFFER_MAX: usize = 16 * 1024;
const POST_CONNECT_COMMAND_AFTER_SSH_START_TIMEOUT: Duration = Duration::from_secs(6);
const TERMINAL_LOG_SNAPSHOT_MAX_BYTES: u64 = 512 * 1024;
const TERMINAL_ENV_DIAGNOSTICS_TIMEOUT: Duration = Duration::from_secs(8);
const COMMIT_MESSAGE_TIMEOUT: Duration = Duration::from_secs(90);
const COMMAND_TIMEOUT_POLL_INTERVAL: Duration = Duration::from_millis(20);

fn run_std_command_with_timeout(
    mut command: StdCommand,
    timeout: Duration,
    label: &str,
) -> Result<std::process::Output> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let started = Instant::now();

    loop {
        if child.try_wait()?.is_some() {
            return Ok(child.wait_with_output()?);
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(anyhow!("{label} timed out after {}s", timeout.as_secs()));
        }
        std::thread::sleep(COMMAND_TIMEOUT_POLL_INTERVAL);
    }
}

fn should_redact_env_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    upper.contains("TOKEN")
        || upper.contains("SECRET")
        || upper.contains("PASSWORD")
        || upper.contains("PASSWD")
        || upper.contains("CREDENTIAL")
        || upper.contains("PRIVATE_KEY")
        || upper.contains("AUTH")
        || upper.contains("COOKIE")
        || upper.contains("SESSION")
        || upper.contains("BEARER")
        || upper.ends_with("_KEY")
}

fn redact_env_line(line: &str) -> String {
    let Some((key, _value)) = line.split_once('=') else {
        return line.to_string();
    };
    if should_redact_env_key(key) {
        format!("{key}=<redacted>")
    } else {
        line.to_string()
    }
}

fn sanitize_env_diagnostics_stdout(raw: &str) -> String {
    let mut result = String::new();
    let mut env_section = true;
    for line in raw.lines() {
        if env_section && line.trim() == "---" {
            env_section = false;
            result.push_str(line);
            result.push('\n');
            continue;
        }
        if env_section {
            result.push_str(&redact_env_line(line));
        } else {
            result.push_str(line);
        }
        result.push('\n');
    }
    if !raw.ends_with('\n') && result.ends_with('\n') {
        result.pop();
    }
    result
}

fn shell_escape_arg(value: &str) -> String {
    if value.is_empty() {
        return "''".to_string();
    }
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn resolve_login_shell() -> String {
    env::var("SHELL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "/bin/zsh".to_string())
}

fn build_claude_shell_command(
    cli_path: &str,
    session_id: &str,
    resume_existing_session: bool,
    full_access_flag: bool,
) -> String {
    let mut parts = vec![
        "env".to_string(),
        "TERM=xterm-256color".to_string(),
        "COLORTERM=truecolor".to_string(),
        "CLICOLOR=1".to_string(),
        "CLICOLOR_FORCE=1".to_string(),
        "FORCE_COLOR=1".to_string(),
        "NO_COLOR=".to_string(),
        shell_escape_arg(cli_path),
    ];
    if resume_existing_session {
        parts.push("--resume".to_string());
    } else {
        parts.push("--session-id".to_string());
    }
    parts.push(shell_escape_arg(session_id));
    if full_access_flag {
        parts.push("--dangerously-skip-permissions".to_string());
    }
    parts.join(" ")
}

fn build_terminal_shell_command(
    workspace_kind: WorkspaceKind,
    rdev_ssh_command: Option<&str>,
    ssh_command: Option<&str>,
    remote_path: Option<&str>,
    claude_shell_command: &str,
) -> Result<(String, Option<String>)> {
    if workspace_kind == WorkspaceKind::Local {
        return Ok((claude_shell_command.to_string(), None));
    }

    let remote_command = match workspace_kind {
        WorkspaceKind::Rdev => {
            let command = rdev_ssh_command
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| anyhow!("Missing rdev ssh command for remote workspace"))?;
            ensure_rdev_non_tmux(command)
        }
        WorkspaceKind::Ssh => ssh_command
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow!("Missing ssh command for remote workspace"))?
            .to_string(),
        WorkspaceKind::Local => unreachable!(),
    };
    let base_exec_claude_command = format!("exec {claude_shell_command}");

    if remote_command.contains("{CLAUDE_CMD}") {
        return Ok((
            remote_command.replace("{CLAUDE_CMD}", &base_exec_claude_command),
            None,
        ));
    }

    let exec_claude_command = if workspace_kind == WorkspaceKind::Ssh {
        if let Some(path) = remote_path
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            format!(
                "cd {} && exec {}",
                shell_escape_arg(path),
                claude_shell_command
            )
        } else {
            base_exec_claude_command
        }
    } else {
        base_exec_claude_command
    };

    Ok((remote_command, Some(exec_claude_command)))
}

fn resolve_claude_command_for_workspace(
    workspace_kind: WorkspaceKind,
    settings: &Settings,
) -> Result<String> {
    if workspace_kind == WorkspaceKind::Rdev || workspace_kind == WorkspaceKind::Ssh {
        return Ok("claude".to_string());
    }

    detect_claude_cli_path(settings)
        .ok_or_else(|| anyhow!("Claude CLI not found. Configure the CLI path in Settings."))
}

fn ensure_rdev_non_tmux(remote_command: &str) -> String {
    let trimmed = remote_command.trim();
    let has_explicit_tmux_mode = trimmed
        .split_whitespace()
        .any(|token| matches!(token, "--tmux" | "--non-tmux" | "-d"));
    if has_explicit_tmux_mode {
        trimmed.to_string()
    } else if trimmed.contains("{CLAUDE_CMD}") {
        trimmed.replacen("{CLAUDE_CMD}", "--non-tmux {CLAUDE_CMD}", 1)
    } else {
        format!("{trimmed} --non-tmux")
    }
}

fn trim_prompt_probe_buffer(buffer: &mut String) {
    if buffer.len() <= POST_CONNECT_PROMPT_BUFFER_MAX {
        return;
    }
    let drain_len = buffer.len() - (POST_CONNECT_PROMPT_BUFFER_MAX / 2);
    buffer.drain(..drain_len);
}

fn looks_like_shell_prompt(buffer: &str) -> bool {
    for line in buffer.replace('\r', "\n").lines().rev().take(8) {
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            continue;
        }

        let lower = trimmed.to_ascii_lowercase();
        if lower.contains("for shortcuts")
            || lower.contains("bypass permissions")
            || lower.contains("claude code")
            || lower.contains("starting ssh connection")
            || lower.contains("uploading gh auth token")
            || lower.contains("now ready to use")
        {
            continue;
        }

        if trimmed.ends_with('$')
            || trimmed.ends_with('#')
            || trimmed.ends_with('%')
            || trimmed.ends_with('>')
        {
            return true;
        }
    }
    false
}

fn should_dispatch_post_connect_command(
    prompt_probe: &str,
    saw_ssh_connection_start: bool,
    elapsed_since_connect_start: Duration,
) -> bool {
    looks_like_shell_prompt(prompt_probe)
        || (saw_ssh_connection_start
            && elapsed_since_connect_start >= POST_CONNECT_COMMAND_AFTER_SSH_START_TIMEOUT)
}

fn is_uuid_like(value: &str) -> bool {
    if value.len() != 36 {
        return false;
    }

    for (index, ch) in value.chars().enumerate() {
        let hyphen_index = matches!(index, 8 | 13 | 18 | 23);
        if hyphen_index {
            if ch != '-' {
                return false;
            }
            continue;
        }

        if !ch.is_ascii_hexdigit() {
            return false;
        }
    }

    true
}

fn strip_ansi_sequences(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' {
            output.push(ch);
            continue;
        }

        let Some(next) = chars.peek().copied() else {
            break;
        };

        if next == '[' {
            let _ = chars.next();
            for ctrl in chars.by_ref() {
                if ('@'..='~').contains(&ctrl) {
                    break;
                }
            }
        } else if next == ']' {
            // OSC: ESC ] ... BEL or ESC ] ... ESC \
            let _ = chars.next();
            let mut saw_escape = false;
            while let Some(ctrl) = chars.next() {
                if ctrl == '\u{7}' {
                    break;
                }
                if saw_escape && ctrl == '\\' {
                    break;
                }
                saw_escape = ctrl == '\u{1b}';
            }
        } else if matches!(next, 'P' | '_' | '^') {
            // DCS/APC/PM: ESC P ... ESC \ (and variants).
            let _ = chars.next();
            let mut saw_escape = false;
            while let Some(ctrl) = chars.next() {
                if saw_escape && ctrl == '\\' {
                    break;
                }
                saw_escape = ctrl == '\u{1b}';
            }
        } else {
            let _ = chars.next();
        }
    }

    output
}

fn extract_claude_resume_session_id(text: &str) -> Option<String> {
    for marker in ["claude --resume ", "--resume "] {
        let mut offset = 0usize;
        while let Some(index) = text[offset..].find(marker) {
            let start = offset + index + marker.len();
            let candidate: String = text[start..]
                .chars()
                .take_while(|ch| ch.is_ascii_hexdigit() || *ch == '-')
                .collect();
            if is_uuid_like(&candidate) {
                return Some(candidate.to_lowercase());
            }
            offset = start;
        }
    }

    None
}

fn extract_resume_session_id_from_chunk(parse_buffer: &mut String, chunk: &str) -> Option<String> {
    let clean = strip_ansi_sequences(chunk);
    if clean.is_empty() {
        return None;
    }

    parse_buffer.push_str(&clean);
    if parse_buffer.len() > SESSION_ID_PARSE_BUFFER_MAX {
        let drain_len = parse_buffer.len() - (SESSION_ID_PARSE_BUFFER_MAX / 2);
        parse_buffer.drain(..drain_len);
    }

    extract_claude_resume_session_id(parse_buffer)
}

fn recover_session_id_from_logs(workspace_id: &str, thread_id: &str) -> Option<String> {
    let snapshot = terminal_get_last_log(workspace_id, thread_id).ok()?;
    if snapshot.trim().is_empty() {
        return None;
    }
    extract_claude_resume_session_id(&strip_ansi_sequences(&snapshot))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TerminalSessionMode {
    Resumed,
    New,
}

impl TerminalSessionMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Resumed => "resumed",
            Self::New => "new",
        }
    }
}

pub type TerminalSessionId = String;

struct TerminalSession {
    session_id: TerminalSessionId,
    workspace_id: String,
    workspace_path: String,
    thread_id: String,
    session_mode: TerminalSessionMode,
    resume_session_id: Option<String>,
    process_id: Option<u32>,
    started_at: chrono::DateTime<Utc>,
    command: Vec<String>,
    output_log_path: PathBuf,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send>>>,
}

fn terminate_terminal_session_process(session: &TerminalSession) {
    if let Some(pid) = session.process_id {
        let result = unsafe { libc::kill(pid as i32, libc::SIGKILL) };
        if result == 0 {
            return;
        }
        if std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
            return;
        }
    }
    if let Ok(mut child) = session.child.lock() {
        let _ = child.kill();
    }
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

    fn remove_for_thread(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<Vec<Arc<TerminalSession>>> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("Terminal session lock poisoned"))?;
        let matching_session_ids = sessions
            .iter()
            .filter(|(_, session)| {
                session.workspace_id == workspace_id && session.thread_id == thread_id
            })
            .map(|(session_id, _)| session_id.clone())
            .collect::<Vec<_>>();
        let mut removed = Vec::new();
        for session_id in matching_session_ids {
            if let Some(session) = sessions.remove(&session_id) {
                removed.push(session);
            }
        }
        Ok(removed)
    }

    pub fn shutdown_for_workspace(&self, workspace_path: &str) -> Result<()> {
        let sessions = {
            let mut guard = self
                .sessions
                .lock()
                .map_err(|_| anyhow!("Terminal session lock poisoned"))?;
            let matching_session_ids = guard
                .iter()
                .filter(|(_, session)| session.workspace_path == workspace_path)
                .map(|(session_id, _)| session_id.clone())
                .collect::<Vec<_>>();
            let mut removed = Vec::new();
            for session_id in matching_session_ids {
                if let Some(session) = guard.remove(&session_id) {
                    removed.push(session);
                }
            }
            removed
        };

        for session in sessions {
            terminate_terminal_session_process(&session);
        }
        Ok(())
    }

    pub fn shutdown_all(&self) {
        let sessions = match self.sessions.lock() {
            Ok(mut guard) => guard
                .drain()
                .map(|(_, session)| session)
                .collect::<Vec<_>>(),
            Err(_) => return,
        };
        for session in sessions {
            terminate_terminal_session_process(&session);
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

    let mut candidates = vec![
        "/usr/local/bin/claude".to_string(),
        "/opt/homebrew/bin/claude".to_string(),
    ];
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

fn read_log_snapshot(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let total_len = file.metadata()?.len();
    let start_offset = total_len.saturating_sub(TERMINAL_LOG_SNAPSHOT_MAX_BYTES);
    if start_offset > 0 {
        file.seek(SeekFrom::Start(start_offset))?;
    }

    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let mut text = String::from_utf8_lossy(&bytes).to_string();

    if start_offset > 0 {
        if let Some(newline_index) = text.find('\n') {
            text = text[(newline_index + 1)..].to_string();
        }
        return Ok(format!(
            "(output truncated to last {} KB)\n{}",
            TERMINAL_LOG_SNAPSHOT_MAX_BYTES / 1024,
            text
        ));
    }

    Ok(text)
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
        if stat.is_empty() {
            "(No changes)"
        } else {
            &stat
        },
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
                content
                    .chars()
                    .rev()
                    .take(max)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect()
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

    if state.terminal_sessions.get(&run_id)?.is_some() {
        return terminal_kill(state, run_id);
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

    read_log_snapshot(last_log)
}

pub fn terminal_read_output(state: Arc<RunnerState>, session_id: String) -> Result<String> {
    let Some(session) = state.terminal_sessions.get(&session_id)? else {
        return Err(anyhow!("Terminal session not found"));
    };

    read_log_snapshot(&session.output_log_path)
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
    let workspace = storage::resolve_workspace_by_path(&workspace_path)?.ok_or_else(|| {
        anyhow!("Workspace not registered. Add workspace before starting terminal.")
    })?;
    let workspace_id = workspace.id.clone();
    let stale_sessions = state
        .terminal_sessions
        .remove_for_thread(&workspace_id, &thread_id)?;
    for stale_session in stale_sessions {
        terminate_terminal_session_process(&stale_session);
    }

    let mut thread = storage::read_thread_metadata(&workspace_id, &thread_id)?;
    let started_at = Utc::now();
    if thread.full_access != full_access_flag {
        thread.full_access = full_access_flag;
    }
    if thread
        .claude_session_id
        .as_deref()
        .is_some_and(|session_id| !is_uuid_like(session_id))
    {
        thread.claude_session_id = None;
    }

    let mut launch_session_id = thread
        .claude_session_id
        .clone()
        .filter(|session_id| is_uuid_like(session_id));
    if launch_session_id.is_none() {
        if let Some(recovered) = recover_session_id_from_logs(&workspace_id, &thread_id) {
            launch_session_id = Some(recovered);
        }
    }
    let generated_session_id = if launch_session_id.is_none() {
        launch_session_id = Some(Uuid::new_v4().to_string());
        true
    } else {
        false
    };
    thread.claude_session_id = launch_session_id.clone();

    let session_mode = if generated_session_id {
        thread.last_new_session_at = Some(started_at);
        TerminalSessionMode::New
    } else {
        thread.last_resume_at = Some(started_at);
        TerminalSessionMode::Resumed
    };
    let launch_session_id =
        launch_session_id.ok_or_else(|| anyhow!("Missing Claude session id"))?;
    let resume_session_id = if session_mode == TerminalSessionMode::Resumed {
        Some(launch_session_id.clone())
    } else {
        None
    };
    thread.updated_at = started_at;
    storage::write_thread_metadata(&thread)?;

    let settings = storage::load_settings()?;
    let claude_command = resolve_claude_command_for_workspace(workspace.kind, &settings)?;

    let cwd = if workspace.kind == WorkspaceKind::Local {
        initial_cwd.unwrap_or_else(|| workspace_path.clone())
    } else {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("/"))
            .to_string_lossy()
            .to_string()
    };
    let session_id = Uuid::new_v4().to_string();
    let run_dir = storage::runs_dir(&workspace_id, &thread_id)?.join(&session_id);
    fs::create_dir_all(&run_dir)?;

    let shell_path = resolve_login_shell();
    let claude_shell_command = build_claude_shell_command(
        &claude_command,
        &launch_session_id,
        session_mode == TerminalSessionMode::Resumed,
        full_access_flag,
    );
    let (shell_command, post_connect_command) = build_terminal_shell_command(
        workspace.kind,
        workspace.rdev_ssh_command.as_deref(),
        workspace.ssh_command.as_deref(),
        workspace.remote_path.as_deref(),
        &claude_shell_command,
    )?;
    let command_manifest = vec![
        shell_path.clone(),
        "-lic".to_string(),
        shell_command.clone(),
    ];
    storage::write_json_file(
        &run_dir.join("input_manifest.json"),
        &serde_json::json!({
            "sessionId": session_id,
            "threadId": thread_id,
            "workspacePath": workspace_path,
            "workspaceId": workspace_id,
            "fullAccess": full_access_flag,
            "sessionMode": session_mode.as_str(),
            "resumeSessionId": resume_session_id.clone(),
            "claudeSessionId": thread.claude_session_id.clone(),
            "launchSessionId": launch_session_id,
            "cwd": cwd,
            "envVars": env_vars,
            "command": command_manifest,
            "shell": shell_path,
            "shellCommand": shell_command,
            "startedAt": started_at,
            "mode": "interactive-terminal"
            ,
            "workspaceKind": match workspace.kind {
                WorkspaceKind::Local => "local",
                WorkspaceKind::Rdev => "rdev",
                WorkspaceKind::Ssh => "ssh"
            },
            "postConnectCommand": post_connect_command
        }),
    )?;

    let pty_system = native_pty_system();
    let pty_pair = pty_system.openpty(PtySize {
        rows: 32,
        cols: 120,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let mut command = CommandBuilder::new(shell_path.clone());
    command.arg("-lic");
    command.arg(shell_command.clone());
    command.cwd(cwd.clone());
    for (key, value) in env::vars() {
        if key == "TERM" || key.eq_ignore_ascii_case("NO_COLOR") {
            continue;
        }
        command.env(key, value);
    }
    if let Some(extra_env) = &env_vars {
        for (key, value) in extra_env {
            if key.eq_ignore_ascii_case("NO_COLOR") {
                continue;
            }
            command.env(key, value);
        }
    }
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("CLICOLOR", "1");
    command.env("CLICOLOR_FORCE", "1");
    command.env("FORCE_COLOR", "1");
    command.env("ZSH_DISABLE_COMPFIX", "true");

    let child = pty_pair.slave.spawn_command(command)?;
    let process_id = child.process_id();
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
        session_mode,
        resume_session_id: resume_session_id.clone(),
        process_id,
        started_at,
        command: command_manifest.clone(),
        output_log_path,
        master: Arc::new(Mutex::new(pty_pair.master)),
        writer: Arc::new(Mutex::new(writer)),
        child: Arc::new(Mutex::new(child)),
    });
    state.terminal_sessions.insert(session.clone())?;

    let data_session_id = session_id.clone();
    let data_workspace_id = workspace_id.clone();
    let data_thread_id = thread_id.clone();
    let data_output_log = output_log.clone();
    let data_app = app.clone();
    let post_connect_writer = session.writer.clone();
    let post_connect_started_at = Instant::now();
    let mut pending_post_connect_command = post_connect_command;
    let mut post_connect_prompt_probe = String::new();
    let mut saw_ssh_connection_start = false;
    let mut should_capture_session_id = false;
    std::thread::spawn(move || {
        let mut buffer = [0u8; 4096];
        let mut utf8_carry = Vec::<u8>::new();
        let mut session_id_parse_buffer = String::new();
        let mut chunk_sequence: u64 = 0;
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
                if pending_post_connect_command.is_some() {
                    let clean_chunk = strip_ansi_sequences(&chunk);
                    if !clean_chunk.is_empty() {
                        let lower = clean_chunk.to_ascii_lowercase();
                        if lower.contains("starting ssh connection")
                            || lower.contains("connected to")
                            || lower.contains("now ready to use")
                        {
                            saw_ssh_connection_start = true;
                        }
                        post_connect_prompt_probe.push_str(&clean_chunk);
                        trim_prompt_probe_buffer(&mut post_connect_prompt_probe);
                    }

                    let should_send_post_connect = should_dispatch_post_connect_command(
                        &post_connect_prompt_probe,
                        saw_ssh_connection_start,
                        post_connect_started_at.elapsed(),
                    );
                    if should_send_post_connect {
                        if let Some(command) = pending_post_connect_command.take() {
                            if let Ok(mut writer) = post_connect_writer.lock() {
                                let _ = writer.write_all(format!("{command}\r").as_bytes());
                                let _ = writer.flush();
                            }
                        }
                        post_connect_prompt_probe.clear();
                    }
                }

                if should_capture_session_id {
                    if let Some(captured_session_id) =
                        extract_resume_session_id_from_chunk(&mut session_id_parse_buffer, &chunk)
                    {
                        if let Ok(Some(updated_thread)) =
                            storage::set_thread_claude_session_id_if_missing(
                                &data_workspace_id,
                                &data_thread_id,
                                &captured_session_id,
                            )
                        {
                            should_capture_session_id = false;
                            let _ = data_app.emit(THREAD_UPDATED_EVENT, updated_thread);
                        }
                    }
                }
                chunk_sequence = chunk_sequence.saturating_add(1);
                let _ = data_app.emit(
                    TERMINAL_DATA_EVENT,
                    TerminalDataEvent {
                        session_id: data_session_id.clone(),
                        thread_id: data_thread_id.clone(),
                        data: chunk,
                        sequence: chunk_sequence,
                    },
                );
            }
        }

        if !utf8_carry.is_empty() {
            let trailing = String::from_utf8_lossy(&utf8_carry).to_string();
            if should_capture_session_id {
                if let Some(captured_session_id) =
                    extract_resume_session_id_from_chunk(&mut session_id_parse_buffer, &trailing)
                {
                    if let Ok(Some(updated_thread)) =
                        storage::set_thread_claude_session_id_if_missing(
                            &data_workspace_id,
                            &data_thread_id,
                            &captured_session_id,
                        )
                    {
                        let _ = data_app.emit(THREAD_UPDATED_EVENT, updated_thread);
                    }
                }
            }
            chunk_sequence = chunk_sequence.saturating_add(1);
            let _ = data_app.emit(
                TERMINAL_DATA_EVENT,
                TerminalDataEvent {
                    session_id: data_session_id.clone(),
                    thread_id: data_thread_id.clone(),
                    data: trailing,
                    sequence: chunk_sequence,
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
                Ok(status) => (Some(status.exit_code() as i32), None),
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
                "sessionMode": wait_session.session_mode.as_str(),
                "resumeSessionId": wait_session.resume_session_id,
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

    Ok(TerminalStartResponse {
        session_id,
        session_mode: session_mode.as_str().to_string(),
        resume_session_id,
        thread,
    })
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

pub fn terminal_resize(
    state: Arc<RunnerState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<bool> {
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

    let Some(pid) = session.process_id else {
        return Err(anyhow!("Terminal session process id is unavailable"));
    };

    let result = unsafe { libc::kill(pid as i32, libc::SIGKILL) };
    if result == 0 {
        let _ = state.terminal_sessions.remove(&session_id);
        return Ok(true);
    }

    let error_code = std::io::Error::last_os_error().raw_os_error();
    if error_code == Some(libc::ESRCH) {
        let _ = state.terminal_sessions.remove(&session_id);
        return Ok(true);
    }

    Err(anyhow!("Failed to terminate terminal session process"))
}

pub fn terminal_send_signal(
    state: Arc<RunnerState>,
    session_id: String,
    signal: String,
) -> Result<bool> {
    let normalized = signal.trim().to_uppercase();
    if normalized != "SIGINT" && normalized != "INT" {
        return Err(anyhow!("Only SIGINT is currently supported"));
    }

    let Some(session) = state.terminal_sessions.get(&session_id)? else {
        return Ok(false);
    };

    if let Some(pid) = session.process_id {
        let result = unsafe { libc::kill(pid as i32, libc::SIGINT) };
        if result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
            return Ok(true);
        }
    }

    terminal_write(state, session_id, "\u{3}".to_string())
}

pub fn copy_terminal_env_diagnostics(workspace_path: String) -> Result<String> {
    let settings = storage::load_settings()?;
    let cli_path = detect_claude_cli_path(&settings)
        .ok_or_else(|| anyhow!("Claude CLI not found. Configure the CLI path in Settings."))?;
    let shell_path = resolve_login_shell();
    let shell_command = format!(
        "env; echo '---'; which claude; echo '---'; {} --version",
        shell_escape_arg(&cli_path)
    );

    let mut command = StdCommand::new(&shell_path);
    command
        .arg("-lic")
        .arg(shell_command)
        .current_dir(&workspace_path)
        .envs(env::vars());
    let output = run_std_command_with_timeout(
        command,
        TERMINAL_ENV_DIAGNOSTICS_TIMEOUT,
        "Terminal diagnostics command",
    )?;
    let sanitized_stdout =
        sanitize_env_diagnostics_stdout(&String::from_utf8_lossy(&output.stdout));

    let mut diagnostics = String::new();
    diagnostics.push_str(&format!("shell={shell_path}\n"));
    diagnostics.push_str(&format!("workspace={workspace_path}\n"));
    diagnostics.push_str("=== stdout ===\n");
    diagnostics.push_str(&sanitized_stdout);
    diagnostics.push_str("\n=== stderr ===\n");
    diagnostics.push_str(&String::from_utf8_lossy(&output.stderr));

    let artifacts_root = storage::ensure_base_dirs()?.join("artifacts");
    fs::create_dir_all(&artifacts_root)?;
    fs::write(
        artifacts_root.join("env-diagnostics.txt"),
        diagnostics.as_bytes(),
    )?;

    Ok(diagnostics)
}

fn extract_mounted_volume_path(hdiutil_output: &str) -> Option<String> {
    hdiutil_output
        .lines()
        .find_map(|line| line.find("/Volumes/").map(|index| line[index..].trim().to_string()))
}

pub fn install_latest_update() -> Result<()> {
    let home_dir = dirs::home_dir().ok_or_else(|| anyhow!("Unable to resolve home directory"))?;
    let downloads_dir = home_dir.join("Downloads");
    fs::create_dir_all(&downloads_dir)?;
    let dmg_path = downloads_dir.join("Claude-Desk.dmg");
    let dmg_path_string = dmg_path.to_string_lossy().to_string();

    let mut download_command = StdCommand::new("curl");
    download_command.args([
        "-L",
        "-o",
        &dmg_path_string,
        "https://github.com/FuRyanf/Claude-Desk/releases/latest/download/Claude-Desk.dmg",
    ]);
    let download_output = run_std_command_with_timeout(
        download_command,
        Duration::from_secs(300),
        "Claude Desk DMG download",
    )?;
    if !download_output.status.success() {
        let stderr = String::from_utf8_lossy(&download_output.stderr);
        return Err(anyhow!("Failed to download latest DMG: {stderr}"));
    }

    let mut attach_command = StdCommand::new("hdiutil");
    attach_command.args(["attach", &dmg_path_string, "-nobrowse"]);
    let attach_output =
        run_std_command_with_timeout(attach_command, Duration::from_secs(60), "DMG mount")?;
    if !attach_output.status.success() {
        let stderr = String::from_utf8_lossy(&attach_output.stderr);
        return Err(anyhow!("Failed to mount DMG: {stderr}"));
    }

    let attach_stdout = String::from_utf8_lossy(&attach_output.stdout);
    let attach_stderr = String::from_utf8_lossy(&attach_output.stderr);
    let mount_path = extract_mounted_volume_path(&attach_stdout)
        .or_else(|| extract_mounted_volume_path(&attach_stderr))
        .ok_or_else(|| anyhow!("Unable to locate mounted DMG volume path"))?;

    let source_app = Path::new(&mount_path).join("Claude Desk.app");
    if !source_app.exists() {
        let _ = StdCommand::new("hdiutil")
            .args(["detach", &mount_path, "-quiet"])
            .status();
        return Err(anyhow!("Mounted DMG does not contain Claude Desk.app"));
    }

    let target_app = PathBuf::from("/Applications/Claude Desk.app");

    let install_result = (|| -> Result<()> {
        let copy_status = StdCommand::new("ditto")
            .arg(&source_app)
            .arg(&target_app)
            .status()?;
        if !copy_status.success() {
            return Err(anyhow!("Failed to copy Claude Desk.app into /Applications"));
        }

        let _ = StdCommand::new("xattr")
            .args(["-dr", "com.apple.quarantine"])
            .arg(&target_app)
            .status();

        Ok(())
    })();

    let _ = StdCommand::new("hdiutil")
        .args(["detach", &mount_path, "-quiet"])
        .status();

    install_result
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
    let enabled_skill_docs =
        skills::resolve_enabled_skills_context(&request.workspace_path, &request.enabled_skills)?;
    let prompt = build_prompt(
        &request.message,
        &context_preview.context_text,
        &enabled_skill_docs,
    );

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
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("Failed to capture Claude stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow!("Failed to capture Claude stderr"))?;

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
            let _ = storage::append_transcript_entry(
                &metadata.workspace_id,
                &metadata.thread_id,
                &entry,
            );
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

    let output = tokio::time::timeout(
        COMMIT_MESSAGE_TIMEOUT,
        Command::new(cli_path)
            .args(args)
            .current_dir(workspace_path)
            .output(),
    )
    .await
    .map_err(|_| {
        anyhow!(
            "Claude commit message generation timed out after {}s",
            COMMIT_MESSAGE_TIMEOUT.as_secs()
        )
    })??;

    if !output.status.success() {
        return Err(anyhow!(
            "Claude failed to generate commit message: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    #[test]
    fn extracts_resume_session_id_from_chunked_terminal_output() {
        let mut parse_buffer = String::new();
        let chunks = [
            "Welcome to Claude Code\n",
            "Resume this session with: claude --resume 123e4567-e89b-12d3-a456-426614174000\n",
            "Done.\n",
        ];

        let mut detected = None;
        for chunk in chunks {
            let maybe_id = extract_resume_session_id_from_chunk(&mut parse_buffer, chunk);
            if maybe_id.is_some() {
                detected = maybe_id;
            }
        }

        assert_eq!(
            detected.as_deref(),
            Some("123e4567-e89b-12d3-a456-426614174000")
        );
    }

    #[test]
    fn extracts_resume_session_id_when_ansi_codes_are_present() {
        let mut parse_buffer = String::new();
        let chunk = "\u{1b}[31mResume this session with:\u{1b}[0m claude --resume ABCDEFAB-CDEF-ABCD-EFAB-ABCDEFABCDEF";
        let detected = extract_resume_session_id_from_chunk(&mut parse_buffer, chunk);
        assert_eq!(
            detected.as_deref(),
            Some("abcdefab-cdef-abcd-efab-abcdefabcdef")
        );
    }

    #[test]
    fn ignores_non_uuid_resume_values() {
        let mut parse_buffer = String::new();
        let detected = extract_resume_session_id_from_chunk(
            &mut parse_buffer,
            "Resume this session with: claude --resume not-a-uuid",
        );
        assert!(detected.is_none());
    }

    #[test]
    fn read_log_snapshot_returns_full_small_logs() {
        let dir =
            std::env::temp_dir().join(format!("claude-desk-runner-log-small-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("should create temp dir");
        let path = dir.join("output.log");

        fs::write(&path, "line 1\nline 2\n").expect("should write fixture log");
        let snapshot = read_log_snapshot(&path).expect("should read snapshot");
        assert_eq!(snapshot, "line 1\nline 2\n");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_log_snapshot_truncates_large_logs() {
        let dir =
            std::env::temp_dir().join(format!("claude-desk-runner-log-large-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("should create temp dir");
        let path = dir.join("output.log");

        let mut file = File::create(&path).expect("should create fixture log");
        for index in 0..120_000 {
            let _ = writeln!(file, "line-{index:05}");
        }

        let snapshot = read_log_snapshot(&path).expect("should read snapshot");
        assert!(
            snapshot.starts_with("(output truncated to last "),
            "snapshot should mark truncation"
        );
        assert!(
            snapshot.contains("line-"),
            "snapshot should include log content"
        );
        assert!(
            !snapshot.contains("line-00000"),
            "snapshot should contain only the tail and exclude earliest lines"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn sanitize_env_diagnostics_stdout_redacts_sensitive_env_keys() {
        let raw = "PATH=/usr/bin\nAPI_TOKEN=super-secret\nSESSION_ID=abc123\n---\nwhich claude\nAPI_TOKEN=after-separator\n";
        let sanitized = sanitize_env_diagnostics_stdout(raw);

        assert!(sanitized.contains("PATH=/usr/bin"));
        assert!(sanitized.contains("API_TOKEN=<redacted>"));
        assert!(sanitized.contains("SESSION_ID=<redacted>"));
        assert!(sanitized.contains("---\nwhich claude\nAPI_TOKEN=after-separator"));
    }

    #[test]
    fn resolve_claude_command_for_rdev_uses_remote_binary() {
        let settings = Settings::default();
        let command =
            resolve_claude_command_for_workspace(WorkspaceKind::Rdev, &settings).expect("rdev command should resolve");
        assert_eq!(command, "claude");
    }

    #[test]
    fn resolve_claude_command_for_ssh_uses_remote_binary() {
        let settings = Settings::default();
        let command =
            resolve_claude_command_for_workspace(WorkspaceKind::Ssh, &settings).expect("ssh command should resolve");
        assert_eq!(command, "claude");
    }

    #[test]
    fn resolve_claude_command_for_local_uses_detected_path() {
        let tmp_dir =
            std::env::temp_dir().join(format!("claude-desk-cli-detect-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&tmp_dir).expect("should create temp directory");
        let cli_path = tmp_dir.join("claude");
        fs::write(&cli_path, "#!/bin/sh\nexit 0\n").expect("should create fake cli");

        let settings = Settings {
            claude_cli_path: Some(cli_path.to_string_lossy().to_string()),
        };
        let command =
            resolve_claude_command_for_workspace(WorkspaceKind::Local, &settings).expect("local command should resolve");
        assert_eq!(command, cli_path.to_string_lossy());

        let _ = fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn build_terminal_shell_command_defaults_rdev_to_non_tmux_post_connect_handoff() {
        let claude_command = build_claude_shell_command(
            "/usr/local/bin/claude",
            "123e4567-e89b-12d3-a456-426614174000",
            false,
            false,
        );
        let (shell_command, post_connect_command) = build_terminal_shell_command(
            WorkspaceKind::Rdev,
            Some("rdev ssh comms-ai-open-connect/offbeat-apple"),
            None,
            Some("~/projects/ignored-for-rdev"),
            &claude_command,
        )
        .expect("rdev command should build");

        assert_eq!(
            shell_command,
            "rdev ssh comms-ai-open-connect/offbeat-apple --non-tmux"
        );
        assert_eq!(
            post_connect_command,
            Some(
                "exec env TERM=xterm-256color COLORTERM=truecolor CLICOLOR=1 CLICOLOR_FORCE=1 FORCE_COLOR=1 NO_COLOR= '/usr/local/bin/claude' --session-id '123e4567-e89b-12d3-a456-426614174000'"
                    .to_string()
            )
        );
    }

    #[test]
    fn build_terminal_shell_command_preserves_explicit_tmux_mode() {
        let claude_command = build_claude_shell_command(
            "/usr/local/bin/claude",
            "123e4567-e89b-12d3-a456-426614174000",
            true,
            true,
        );
        let (shell_command, post_connect_command) = build_terminal_shell_command(
            WorkspaceKind::Rdev,
            Some("rdev ssh comms-ai-open-connect/offbeat-apple --tmux"),
            None,
            Some("~/projects/ignored-for-rdev"),
            &claude_command,
        )
        .expect("rdev command should build");

        assert_eq!(
            shell_command,
            "rdev ssh comms-ai-open-connect/offbeat-apple --tmux"
        );
        assert_eq!(
            post_connect_command,
            Some(
                "exec env TERM=xterm-256color COLORTERM=truecolor CLICOLOR=1 CLICOLOR_FORCE=1 FORCE_COLOR=1 NO_COLOR= '/usr/local/bin/claude' --resume '123e4567-e89b-12d3-a456-426614174000' --dangerously-skip-permissions".to_string()
            )
        );
    }

    #[test]
    fn build_terminal_shell_command_supports_placeholder_substitution() {
        let claude_command = build_claude_shell_command(
            "/usr/local/bin/claude",
            "123e4567-e89b-12d3-a456-426614174000",
            false,
            false,
        );
        let (shell_command, post_connect_command) = build_terminal_shell_command(
            WorkspaceKind::Rdev,
            Some("rdev ssh comms-ai-open-connect/offbeat-apple {CLAUDE_CMD}"),
            None,
            Some("~/projects/ignored-for-rdev"),
            &claude_command,
        )
        .expect("placeholder command should build");

        assert_eq!(
            shell_command,
            "rdev ssh comms-ai-open-connect/offbeat-apple --non-tmux exec env TERM=xterm-256color COLORTERM=truecolor CLICOLOR=1 CLICOLOR_FORCE=1 FORCE_COLOR=1 NO_COLOR= '/usr/local/bin/claude' --session-id '123e4567-e89b-12d3-a456-426614174000'"
        );
        assert_eq!(post_connect_command, None);
    }

    #[test]
    fn build_terminal_shell_command_for_ssh_dispatches_post_connect_handoff() {
        let claude_command = build_claude_shell_command(
            "/usr/local/bin/claude",
            "123e4567-e89b-12d3-a456-426614174000",
            false,
            false,
        );
        let (shell_command, post_connect_command) = build_terminal_shell_command(
            WorkspaceKind::Ssh,
            None,
            Some("ssh rfu@bloody-faraday"),
            Some("~/projects/atc"),
            &claude_command,
        )
        .expect("ssh command should build");

        assert_eq!(shell_command, "ssh rfu@bloody-faraday");
        assert_eq!(
            post_connect_command,
            Some(
                "cd '~/projects/atc' && exec env TERM=xterm-256color COLORTERM=truecolor CLICOLOR=1 CLICOLOR_FORCE=1 FORCE_COLOR=1 NO_COLOR= '/usr/local/bin/claude' --session-id '123e4567-e89b-12d3-a456-426614174000'"
                    .to_string()
            )
        );
    }

    #[test]
    fn build_terminal_shell_command_for_ssh_skips_cd_when_remote_path_missing_or_empty() {
        let claude_command = build_claude_shell_command(
            "/usr/local/bin/claude",
            "123e4567-e89b-12d3-a456-426614174000",
            false,
            false,
        );

        let (_, without_path) = build_terminal_shell_command(
            WorkspaceKind::Ssh,
            None,
            Some("ssh rfu@bloody-faraday"),
            None,
            &claude_command,
        )
        .expect("ssh command without path should build");
        assert_eq!(
            without_path,
            Some(
                "exec env TERM=xterm-256color COLORTERM=truecolor CLICOLOR=1 CLICOLOR_FORCE=1 FORCE_COLOR=1 NO_COLOR= '/usr/local/bin/claude' --session-id '123e4567-e89b-12d3-a456-426614174000'"
                    .to_string()
            )
        );

        let (_, with_empty_path) = build_terminal_shell_command(
            WorkspaceKind::Ssh,
            None,
            Some("ssh rfu@bloody-faraday"),
            Some("   "),
            &claude_command,
        )
        .expect("ssh command with empty path should build");
        assert_eq!(with_empty_path, without_path);
    }

    #[test]
    fn build_terminal_shell_command_for_ssh_placeholder_skips_remote_path_prefix() {
        let claude_command = build_claude_shell_command(
            "/usr/local/bin/claude",
            "123e4567-e89b-12d3-a456-426614174000",
            false,
            false,
        );
        let (shell_command, post_connect_command) = build_terminal_shell_command(
            WorkspaceKind::Ssh,
            None,
            Some("ssh rfu@bloody-faraday {CLAUDE_CMD}"),
            Some("~/projects/should-not-be-applied"),
            &claude_command,
        )
        .expect("ssh placeholder command should build");

        assert_eq!(
            shell_command,
            "ssh rfu@bloody-faraday exec env TERM=xterm-256color COLORTERM=truecolor CLICOLOR=1 CLICOLOR_FORCE=1 FORCE_COLOR=1 NO_COLOR= '/usr/local/bin/claude' --session-id '123e4567-e89b-12d3-a456-426614174000'"
        );
        assert_eq!(post_connect_command, None);
    }

    #[test]
    fn strip_ansi_sequences_removes_osc_payloads() {
        let stripped =
            strip_ansi_sequences("\u{1b}]10;rgb:d8d8/e0e0/efef\u{7}\n[rfu@host workspace]$ ");
        assert_eq!(stripped, "\n[rfu@host workspace]$ ");
    }

    #[test]
    fn looks_like_shell_prompt_detects_remote_prompt() {
        assert!(looks_like_shell_prompt("[rfu@bloody-faraday workspace]$ "));
    }

    #[test]
    fn looks_like_shell_prompt_ignores_rdev_bootstrap_lines() {
        assert!(!looks_like_shell_prompt(
            "Uploading gh auth token to the rdev\nStarting ssh connection to li-productivity-agents/bloody-faraday\n"
        ));
    }

    #[test]
    fn should_dispatch_post_connect_command_on_prompt_even_without_timeout() {
        assert!(should_dispatch_post_connect_command(
            "[rfu@bloody-faraday li-productivity-agents]$ ",
            false,
            Duration::from_secs(1),
        ));
    }

    #[test]
    fn should_not_dispatch_post_connect_command_before_timeout_without_prompt() {
        assert!(!should_dispatch_post_connect_command(
            "Starting ssh connection to li-productivity-agents/bloody-faraday\n",
            true,
            Duration::from_secs(1),
        ));
    }

    #[test]
    fn should_dispatch_post_connect_command_after_timeout_when_ssh_started() {
        assert!(should_dispatch_post_connect_command(
            "Starting ssh connection to li-productivity-agents/bloody-faraday\n",
            true,
            POST_CONNECT_COMMAND_AFTER_SSH_START_TIMEOUT + Duration::from_secs(1),
        ));
    }
}
