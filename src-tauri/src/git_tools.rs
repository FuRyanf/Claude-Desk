use std::process::Command;

use anyhow::Result;

use crate::models::{GitDiffSummary, GitInfo};

fn run_git(workspace_path: &str, args: &[&str]) -> Result<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(workspace_path)
        .output()?;

    if !output.status.success() {
        return Ok(String::new());
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub fn get_git_info(workspace_path: &str) -> Result<Option<GitInfo>> {
    let is_repo = run_git(workspace_path, &["rev-parse", "--is-inside-work-tree"])?;
    if is_repo.trim() != "true" {
        return Ok(None);
    }

    let branch = run_git(workspace_path, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if branch.is_empty() {
        return Ok(None);
    }

    let short_hash = run_git(workspace_path, &["rev-parse", "--short", "HEAD"])?;
    let status = run_git(workspace_path, &["status", "--porcelain"])?;
    let is_dirty = !status.trim().is_empty();
    let ahead_behind = run_git(workspace_path, &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"])?;
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

    Ok(GitDiffSummary {
        stat,
        diff_excerpt,
    })
}

pub fn capture_patch_diff(workspace_path: &str) -> Result<String> {
    run_git(workspace_path, &["diff"])
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
        let temp_repo = std::env::temp_dir().join(format!("claude-desk-git-test-{}", uuid::Uuid::new_v4()));
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
}
