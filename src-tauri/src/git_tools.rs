use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};

use crate::models::{GitBranchEntry, GitDiffSummary, GitInfo, GitWorkspaceStatus};

const GIT_TIMEOUT: Duration = Duration::from_secs(8);
const GIT_WAIT_POLL_INTERVAL: Duration = Duration::from_millis(20);

fn run_command_with_timeout(
    mut command: Command,
    timeout: Duration,
    label: &str,
) -> Result<Output> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn()?;
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
        std::thread::sleep(GIT_WAIT_POLL_INTERVAL);
    }
}

fn validate_branch_name(branch_name: &str) -> Result<&str> {
    let normalized = branch_name.trim();
    if normalized.is_empty() {
        return Err(anyhow!("Branch name cannot be empty"));
    }
    if normalized.starts_with('-') {
        return Err(anyhow!("Branch name cannot start with '-'"));
    }
    if normalized.contains('\0') {
        return Err(anyhow!("Branch name cannot contain NUL bytes"));
    }
    Ok(normalized)
}

fn run_git(workspace_path: &str, args: &[&str]) -> Result<String> {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(workspace_path)
        .env("GIT_TERMINAL_PROMPT", "0");
    let output = run_command_with_timeout(command, GIT_TIMEOUT, "git command")?;

    if !output.status.success() {
        return Ok(String::new());
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn run_git_checked(workspace_path: &str, args: &[&str]) -> Result<String> {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(workspace_path)
        .env("GIT_TERMINAL_PROMPT", "0");
    let output = run_command_with_timeout(command, GIT_TIMEOUT, "git command")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let message = if stderr.is_empty() {
            format!("git {:?} failed", args)
        } else {
            stderr
        };
        return Err(anyhow!(message));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn is_git_repo(workspace_path: &str) -> Result<bool> {
    let is_repo = run_git(workspace_path, &["rev-parse", "--is-inside-work-tree"])?;
    Ok(is_repo.trim() == "true")
}

pub fn get_git_info(workspace_path: &str) -> Result<Option<GitInfo>> {
    if !is_git_repo(workspace_path)? {
        return Ok(None);
    }

    let mut branch = run_git(workspace_path, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if branch.is_empty() {
        return Ok(None);
    }

    let short_hash = run_git(workspace_path, &["rev-parse", "--short", "HEAD"])?;
    if branch == "HEAD" && !short_hash.is_empty() {
        branch = format!("(detached at {short_hash})");
    }
    let status = run_git(workspace_path, &["status", "--porcelain"])?;
    let is_dirty = !status.trim().is_empty();
    let ahead_behind = run_git(
        workspace_path,
        &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
    )?;
    let (ahead, behind) = parse_ahead_behind(&ahead_behind);

    Ok(Some(GitInfo {
        branch,
        short_hash,
        is_dirty,
        ahead,
        behind,
    }))
}

pub fn get_git_diff_summary(workspace_path: &str) -> Result<GitDiffSummary> {
    let stat = run_git(workspace_path, &["diff", "--stat"])?;
    let mut diff_excerpt = run_git(workspace_path, &["diff"])?;
    let max = 15_000;
    if diff_excerpt.len() > max {
        diff_excerpt.truncate(max);
        diff_excerpt.push_str("\n...\n(diff truncated)");
    }

    Ok(GitDiffSummary { stat, diff_excerpt })
}

pub fn capture_patch_diff(workspace_path: &str) -> Result<String> {
    run_git(workspace_path, &["diff"])
}

pub fn list_branches(workspace_path: &str) -> Result<Vec<GitBranchEntry>> {
    if !is_git_repo(workspace_path)? {
        return Ok(Vec::new());
    }

    let current_branch = run_git(workspace_path, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let refs = run_git(
        workspace_path,
        &[
            "for-each-ref",
            "refs/heads/",
            "--format=%(refname:short)\t%(committerdate:unix)",
            "--sort=-committerdate",
        ],
    )?;

    let mut branches = Vec::new();
    for line in refs.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let mut parts = trimmed.splitn(2, '\t');
        let name = parts.next().unwrap_or_default().trim().to_string();
        if name.is_empty() {
            continue;
        }
        let last_commit_unix = parts
            .next()
            .and_then(|value| value.trim().parse::<i64>().ok())
            .unwrap_or(0);
        branches.push(GitBranchEntry {
            is_current: name == current_branch,
            name,
            last_commit_unix,
        });
    }

    Ok(branches)
}

pub fn workspace_status(workspace_path: &str) -> Result<GitWorkspaceStatus> {
    if !is_git_repo(workspace_path)? {
        return Ok(GitWorkspaceStatus {
            is_dirty: false,
            uncommitted_files: 0,
            insertions: 0,
            deletions: 0,
        });
    }

    let status = run_git(workspace_path, &["status", "--porcelain"])?;
    let uncommitted_files = status
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count() as u32;

    let numstat = run_git(workspace_path, &["diff", "--numstat"])?;
    let mut insertions = 0u32;
    let mut deletions = 0u32;

    for line in numstat.lines() {
        let mut fields = line.split_whitespace();
        let Some(ins) = fields.next() else {
            continue;
        };
        let Some(del) = fields.next() else {
            continue;
        };
        if let Ok(value) = ins.parse::<u32>() {
            insertions = insertions.saturating_add(value);
        }
        if let Ok(value) = del.parse::<u32>() {
            deletions = deletions.saturating_add(value);
        }
    }

    Ok(GitWorkspaceStatus {
        is_dirty: uncommitted_files > 0,
        uncommitted_files,
        insertions,
        deletions,
    })
}

pub fn checkout_branch(workspace_path: &str, branch_name: &str) -> Result<()> {
    let normalized = validate_branch_name(branch_name)?;
    run_git_checked(
        workspace_path,
        &["check-ref-format", "--branch", normalized],
    )?;
    run_git_checked(workspace_path, &["checkout", normalized]).map(|_| ())
}

pub fn create_and_checkout_branch(workspace_path: &str, branch_name: &str) -> Result<()> {
    let normalized = validate_branch_name(branch_name)?;
    run_git_checked(
        workspace_path,
        &["check-ref-format", "--branch", normalized],
    )?;
    run_git_checked(workspace_path, &["checkout", "-b", normalized]).map(|_| ())
}

fn parse_ahead_behind(input: &str) -> (u32, u32) {
    let mut parts = input.split_whitespace();
    let ahead = parts
        .next()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0);
    let behind = parts
        .next()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0);
    (ahead, behind)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;
    use std::process::Command;

    fn git(workdir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(workdir)
            .status()
            .expect("git command should execute");
        assert!(status.success(), "git {:?} failed", args);
    }

    #[test]
    fn detects_git_branch_and_dirty_state() {
        let temp_repo =
            std::env::temp_dir().join(format!("claude-desk-git-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&temp_repo).expect("failed to create temp repo");

        git(&temp_repo, &["init"]);
        git(&temp_repo, &["config", "user.email", "test@example.com"]);
        git(&temp_repo, &["config", "user.name", "Claude Desk Test"]);

        fs::write(temp_repo.join("README.md"), "initial\n").expect("failed to write file");
        git(&temp_repo, &["add", "README.md"]);
        git(&temp_repo, &["commit", "-m", "initial"]);

        let clean = get_git_info(temp_repo.to_string_lossy().as_ref())
            .expect("git info should resolve")
            .expect("repo should be detected");
        assert!(!clean.branch.is_empty());
        assert!(!clean.short_hash.is_empty());
        assert!(!clean.is_dirty);
        assert_eq!(clean.ahead, 0);
        assert_eq!(clean.behind, 0);

        fs::write(temp_repo.join("README.md"), "changed\n").expect("failed to update file");
        let dirty = get_git_info(temp_repo.to_string_lossy().as_ref())
            .expect("git info should resolve after modification")
            .expect("repo should still be detected");
        assert!(dirty.is_dirty);

        let _ = fs::remove_dir_all(temp_repo);
    }

    #[test]
    fn parses_ahead_behind_counts() {
        assert_eq!(parse_ahead_behind("3\t2"), (3, 2));
        assert_eq!(parse_ahead_behind(""), (0, 0));
        assert_eq!(parse_ahead_behind("bad input"), (0, 0));
    }

    #[test]
    fn rejects_unsafe_branch_names() {
        assert!(validate_branch_name("").is_err());
        assert!(validate_branch_name("   ").is_err());
        assert!(validate_branch_name("-main").is_err());
        assert!(validate_branch_name("feature/test").is_ok());
    }
}
