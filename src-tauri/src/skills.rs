use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Result;

use crate::models::SkillInfo;

const PROJECT_SKILLS_DIR: &str = ".claude/skills";
const LEGACY_PROJECT_SKILLS_DIR: &str = "skills";

pub fn list_skills(workspace_path: &str) -> Result<Vec<SkillInfo>> {
    let mut discovered = Vec::new();
    let mut seen_ids = HashSet::new();

    for (root_path, relative_root) in skill_roots(workspace_path) {
        if !root_path.exists() {
            continue;
        }

        let root_entries = match fs::read_dir(&root_path) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        for entry in root_entries {
            let Ok(entry) = entry else {
                continue;
            };
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }

            let skill_md = path.join("SKILL.md");
            if !skill_md.exists() {
                continue;
            }

            let id = path
                .file_name()
                .map(|name| name.to_string_lossy().trim().to_string())
                .unwrap_or_default();
            if id.is_empty() || seen_ids.contains(&id) {
                continue;
            }

            let raw = match fs::read_to_string(&skill_md) {
                Ok(raw) => raw,
                Err(_) => continue,
            };

            let parsed = parse_skill_markdown(&raw, &id);
            discovered.push(SkillInfo {
                id: id.clone(),
                name: parsed.name,
                description: parsed.description,
                entry_points: parsed.entry_points,
                path: path.to_string_lossy().to_string(),
                relative_path: format!("{relative_root}/{id}/SKILL.md"),
                warning: parsed.warning,
            });
            seen_ids.insert(id);
        }
    }

    discovered.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(discovered)
}

pub fn resolve_enabled_skills_context(
    workspace_path: &str,
    enabled_ids: &[String],
) -> Result<Vec<(String, String)>> {
    let mut result = Vec::new();
    for skill_id in enabled_ids {
        let Some(skill_file) = resolve_skill_file(workspace_path, skill_id) else {
            continue;
        };
        let raw = match fs::read_to_string(&skill_file) {
            Ok(raw) => raw,
            Err(_) => continue,
        };
        result.push((skill_id.clone(), raw));
    }

    Ok(result)
}

#[derive(Debug)]
struct ParsedSkillMarkdown {
    name: String,
    description: String,
    entry_points: Vec<String>,
    warning: Option<String>,
}

fn skill_roots(workspace_path: &str) -> Vec<(PathBuf, &'static str)> {
    let workspace = Path::new(workspace_path);
    vec![
        (workspace.join(PROJECT_SKILLS_DIR), PROJECT_SKILLS_DIR),
        (workspace.join(LEGACY_PROJECT_SKILLS_DIR), LEGACY_PROJECT_SKILLS_DIR),
    ]
}

fn resolve_skill_file(workspace_path: &str, skill_id: &str) -> Option<PathBuf> {
    for (root_path, _) in skill_roots(workspace_path) {
        let candidate = root_path.join(skill_id).join("SKILL.md");
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn parse_skill_markdown(raw: &str, fallback_id: &str) -> ParsedSkillMarkdown {
    let lines: Vec<&str> = raw.lines().collect();
    let mut heading: Option<String> = None;
    let mut description_lines = Vec::new();
    let mut entry_points = Vec::new();

    for line in &lines {
        let trimmed = line.trim();
        if !trimmed.starts_with("# ") {
            continue;
        }
        let normalized = trimmed.trim_start_matches('#').trim();
        if !normalized.is_empty() {
            heading = Some(normalized.to_string());
            break;
        }
    }

    let mut heading_seen = false;
    for line in &lines {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            if heading_seen {
                break;
            }
            heading_seen = true;
            continue;
        }
        if !heading_seen {
            continue;
        }
        if trimmed.is_empty() {
            if !description_lines.is_empty() {
                break;
            }
            continue;
        }
        description_lines.push(trimmed.to_string());
    }

    if let Some((start_idx, _)) = lines.iter().enumerate().find(|(_, line)| {
        line.trim_start()
            .to_lowercase()
            .starts_with("## entry points")
    }) {
        for line in lines.iter().skip(start_idx + 1) {
            let trimmed = line.trim();
            if trimmed.starts_with("## ") {
                break;
            }
            if trimmed.starts_with("- ") || trimmed.starts_with("* ") {
                entry_points.push(trimmed[2..].trim().to_string());
            }
        }
    }

    let warning = if heading.is_none() {
        Some("Missing top-level title in SKILL.md. Using the folder name instead.".to_string())
    } else {
        None
    };

    ParsedSkillMarkdown {
        name: heading.unwrap_or_else(|| fallback_id.to_string()),
        description: description_lines.join(" "),
        entry_points,
        warning,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn discovers_skill_markdown_from_project_skills_fixture() {
        let workspace =
            std::env::temp_dir().join(format!("claude-desk-skills-test-{}", uuid::Uuid::new_v4()));
        let skill_dir = workspace.join(".claude").join("skills").join("refactor");
        fs::create_dir_all(&skill_dir).expect("failed to create fixture skill directory");
        fs::write(
            skill_dir.join("SKILL.md"),
            "# Refactor Skill\n\nImproves refactor consistency.\n\n## Entry Points\n- /skill refactor\n",
        )
        .expect("failed to write fixture SKILL.md");

        let discovered = list_skills(workspace.to_string_lossy().as_ref())
            .expect("skill listing should succeed");
        assert_eq!(discovered.len(), 1);
        assert_eq!(discovered[0].id, "refactor");
        assert_eq!(discovered[0].name, "Refactor Skill");
        assert_eq!(discovered[0].relative_path, ".claude/skills/refactor/SKILL.md");
        assert!(discovered[0]
            .entry_points
            .iter()
            .any(|entry| entry.contains("/skill refactor")));

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn falls_back_to_legacy_workspace_skills_dir() {
        let workspace =
            std::env::temp_dir().join(format!("claude-desk-legacy-skills-test-{}", uuid::Uuid::new_v4()));
        let skill_dir = workspace.join("skills").join("review");
        fs::create_dir_all(&skill_dir).expect("failed to create fixture skill directory");
        fs::write(
            skill_dir.join("SKILL.md"),
            "Review comments carefully.\n\n## Entry Points\n- /skill review\n",
        )
        .expect("failed to write fixture SKILL.md");

        let discovered = list_skills(workspace.to_string_lossy().as_ref())
            .expect("skill listing should succeed");
        assert_eq!(discovered.len(), 1);
        assert_eq!(discovered[0].id, "review");
        assert_eq!(discovered[0].name, "review");
        assert_eq!(discovered[0].relative_path, "skills/review/SKILL.md");
        assert!(discovered[0].warning.is_some());

        let _ = fs::remove_dir_all(workspace);
    }
}
