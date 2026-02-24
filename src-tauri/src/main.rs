#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod git_tools;
mod models;
mod runner;
mod skills;
mod storage;

use std::sync::Arc;

use tauri::{Manager, State};

use crate::models::{
    ContextPreview, GitBranchEntry, GitDiffSummary, GitInfo, GitPullForNewThreadResult,
    GitWorkspaceStatus, RunClaudeRequest, RunClaudeResponse, Settings, SkillInfo,
    TerminalStartResponse, ThreadMetadata, TranscriptEntry, Workspace,
};

struct AppState {
    runner: Arc<runner::RunnerState>,
}

#[tauri::command]
fn get_app_storage_root() -> Result<String, String> {
    storage::ensure_base_dirs()
        .map(|path| path.to_string_lossy().to_string())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_workspaces() -> Result<Vec<Workspace>, String> {
    storage::load_workspaces().map_err(|error| error.to_string())
}

#[tauri::command]
fn add_workspace(path: String) -> Result<Workspace, String> {
    storage::add_workspace(&path).map_err(|error| error.to_string())
}

#[tauri::command]
fn add_rdev_workspace(
    rdev_ssh_command: String,
    display_name: Option<String>,
) -> Result<Workspace, String> {
    storage::add_rdev_workspace(&rdev_ssh_command, display_name.as_deref())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_workspace_order(workspace_ids: Vec<String>) -> Result<Vec<Workspace>, String> {
    storage::set_workspace_order(workspace_ids).map_err(|error| error.to_string())
}

#[tauri::command]
fn remove_workspace(state: State<'_, AppState>, workspace_id: String) -> Result<bool, String> {
    let workspace = storage::load_workspaces()
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|item| item.id == workspace_id);

    if let Some(item) = workspace.as_ref() {
        state
            .runner
            .terminal_sessions
            .shutdown_for_workspace(&item.path)
            .map_err(|error| error.to_string())?;
    }

    storage::remove_workspace(&workspace_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn set_workspace_git_pull_on_master_for_new_threads(
    workspace_id: String,
    enabled: bool,
) -> Result<Workspace, String> {
    storage::set_workspace_git_pull_on_master_for_new_threads(&workspace_id, enabled)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_git_info(workspace_path: String) -> Result<Option<GitInfo>, String> {
    git_tools::get_git_info(&workspace_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn get_git_diff_summary(workspace_path: String) -> Result<GitDiffSummary, String> {
    git_tools::get_git_diff_summary(&workspace_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn git_list_branches(workspace_path: String) -> Result<Vec<GitBranchEntry>, String> {
    git_tools::list_branches(&workspace_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn git_workspace_status(workspace_path: String) -> Result<GitWorkspaceStatus, String> {
    git_tools::workspace_status(&workspace_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn git_checkout_branch(
    state: State<'_, AppState>,
    workspace_path: String,
    branch_name: String,
) -> Result<bool, String> {
    state
        .runner
        .terminal_sessions
        .shutdown_for_workspace(&workspace_path)
        .map_err(|error| error.to_string())?;
    git_tools::checkout_branch(&workspace_path, &branch_name)
        .map(|_| true)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn git_create_and_checkout_branch(
    state: State<'_, AppState>,
    workspace_path: String,
    branch_name: String,
) -> Result<bool, String> {
    state
        .runner
        .terminal_sessions
        .shutdown_for_workspace(&workspace_path)
        .map_err(|error| error.to_string())?;
    git_tools::create_and_checkout_branch(&workspace_path, &branch_name)
        .map(|_| true)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn git_auto_pull_on_master(workspace_path: String) -> Result<bool, String> {
    git_tools::auto_pull_on_master(&workspace_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn git_pull_master_for_new_thread(
    workspace_path: String,
) -> Result<GitPullForNewThreadResult, String> {
    git_tools::git_pull_master_for_new_thread(&workspace_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn list_threads(workspace_id: String) -> Result<Vec<ThreadMetadata>, String> {
    storage::list_threads(&workspace_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn create_thread(workspace_id: String, agent_id: Option<String>) -> Result<ThreadMetadata, String> {
    storage::create_thread(&workspace_id, agent_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn set_thread_full_access(
    workspace_id: String,
    thread_id: String,
    full_access: bool,
) -> Result<ThreadMetadata, String> {
    storage::set_thread_full_access(&workspace_id, &thread_id, full_access)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn clear_thread_claude_session(
    workspace_id: String,
    thread_id: String,
) -> Result<ThreadMetadata, String> {
    storage::clear_thread_claude_session(&workspace_id, &thread_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_thread_skills(
    workspace_id: String,
    thread_id: String,
    enabled_skills: Vec<String>,
) -> Result<ThreadMetadata, String> {
    storage::set_thread_skills(&workspace_id, &thread_id, enabled_skills)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_thread_agent(
    workspace_id: String,
    thread_id: String,
    agent_id: String,
) -> Result<ThreadMetadata, String> {
    storage::set_thread_agent(&workspace_id, &thread_id, agent_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn rename_thread(
    workspace_id: String,
    thread_id: String,
    title: String,
) -> Result<ThreadMetadata, String> {
    storage::rename_thread(&workspace_id, &thread_id, title).map_err(|error| error.to_string())
}

#[tauri::command]
fn archive_thread(workspace_id: String, thread_id: String) -> Result<ThreadMetadata, String> {
    storage::archive_thread(&workspace_id, &thread_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn delete_thread(workspace_id: String, thread_id: String) -> Result<bool, String> {
    storage::delete_thread(&workspace_id, &thread_id)
        .map(|_| true)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn append_user_message(
    workspace_id: String,
    thread_id: String,
    content: String,
) -> Result<TranscriptEntry, String> {
    storage::append_user_message(&workspace_id, &thread_id, &content)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn load_transcript(
    workspace_id: String,
    thread_id: String,
) -> Result<Vec<TranscriptEntry>, String> {
    storage::load_transcript(&workspace_id, &thread_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn list_skills(workspace_path: String) -> Result<Vec<SkillInfo>, String> {
    skills::list_skills(&workspace_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn build_context_preview(
    workspace_path: String,
    context_pack: String,
) -> Result<ContextPreview, String> {
    runner::build_context_preview(&workspace_path, &context_pack).map_err(|error| error.to_string())
}

#[tauri::command]
fn get_settings() -> Result<Settings, String> {
    storage::load_settings().map_err(|error| error.to_string())
}

#[tauri::command]
fn save_settings(settings: Settings) -> Result<Settings, String> {
    storage::save_settings(&settings)
        .map(|_| settings)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn detect_claude_cli_path() -> Result<Option<String>, String> {
    let settings = storage::load_settings().map_err(|error| error.to_string())?;
    Ok(runner::detect_claude_cli_path(&settings))
}

#[tauri::command]
async fn run_claude(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request: RunClaudeRequest,
) -> Result<RunClaudeResponse, String> {
    runner::run_claude(app, state.runner.clone(), request)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn cancel_run(state: State<'_, AppState>, run_id: String) -> Result<bool, String> {
    runner::cancel_run(state.runner.clone(), run_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn terminal_start_session(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    workspace_path: String,
    initial_cwd: Option<String>,
    env_vars: Option<std::collections::HashMap<String, String>>,
    full_access_flag: bool,
    thread_id: String,
) -> Result<TerminalStartResponse, String> {
    runner::terminal_start_session(
        app,
        state.runner.clone(),
        workspace_path,
        initial_cwd,
        env_vars,
        full_access_flag,
        thread_id,
    )
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn terminal_write(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<bool, String> {
    runner::terminal_write(state.runner.clone(), session_id, data)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn terminal_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<bool, String> {
    runner::terminal_resize(state.runner.clone(), session_id, cols, rows)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn terminal_kill(state: State<'_, AppState>, session_id: String) -> Result<bool, String> {
    runner::terminal_kill(state.runner.clone(), session_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn terminal_send_signal(
    state: State<'_, AppState>,
    session_id: String,
    signal: String,
) -> Result<bool, String> {
    runner::terminal_send_signal(state.runner.clone(), session_id, signal)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn terminal_get_last_log(workspace_id: String, thread_id: String) -> Result<String, String> {
    runner::terminal_get_last_log(&workspace_id, &thread_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn terminal_read_output(state: State<'_, AppState>, session_id: String) -> Result<String, String> {
    runner::terminal_read_output(state.runner.clone(), session_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn generate_commit_message(
    workspace_path: String,
    full_access: bool,
) -> Result<String, String> {
    runner::generate_commit_message(workspace_path, full_access)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn open_in_finder(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(path)
        .status()
        .map_err(|error| error.to_string())
        .and_then(|status| {
            if status.success() {
                Ok(())
            } else {
                Err("Failed to open path".to_string())
            }
        })
}

#[tauri::command]
fn open_in_terminal(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .arg("-a")
        .arg("Terminal")
        .arg(path)
        .status()
        .map_err(|error| error.to_string())
        .and_then(|status| {
            if status.success() {
                Ok(())
            } else {
                Err("Failed to open terminal".to_string())
            }
        })
}

#[tauri::command]
fn open_terminal_command(command: String) -> Result<(), String> {
    let escaped = command
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', " ");
    let script = format!(
        "tell application \"Terminal\"\nactivate\ndo script \"{}\"\nend tell",
        escaped
    );
    std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .status()
        .map_err(|error| error.to_string())
        .and_then(|status| {
            if status.success() {
                Ok(())
            } else {
                Err("Failed to open terminal command".to_string())
            }
        })
}

#[tauri::command]
fn copy_terminal_env_diagnostics(workspace_path: String) -> Result<String, String> {
    runner::copy_terminal_env_diagnostics(workspace_path).map_err(|error| error.to_string())
}

fn main() {
    let _ = storage::ensure_base_dirs();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            runner: Arc::new(runner::RunnerState::default()),
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let state = window.state::<AppState>();
                state.runner.terminal_sessions.shutdown_all();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_app_storage_root,
            list_workspaces,
            add_workspace,
            add_rdev_workspace,
            set_workspace_order,
            remove_workspace,
            set_workspace_git_pull_on_master_for_new_threads,
            get_git_info,
            get_git_diff_summary,
            git_list_branches,
            git_workspace_status,
            git_checkout_branch,
            git_create_and_checkout_branch,
            git_auto_pull_on_master,
            git_pull_master_for_new_thread,
            list_threads,
            create_thread,
            set_thread_full_access,
            clear_thread_claude_session,
            set_thread_skills,
            set_thread_agent,
            rename_thread,
            archive_thread,
            delete_thread,
            append_user_message,
            load_transcript,
            list_skills,
            build_context_preview,
            get_settings,
            save_settings,
            detect_claude_cli_path,
            run_claude,
            cancel_run,
            terminal_start_session,
            terminal_write,
            terminal_resize,
            terminal_kill,
            terminal_send_signal,
            terminal_get_last_log,
            terminal_read_output,
            generate_commit_message,
            open_in_finder,
            open_in_terminal,
            open_terminal_command,
            copy_terminal_env_diagnostics
        ])
        .run(tauri::generate_context!())
        .expect("error while running Claude Desk");
}
