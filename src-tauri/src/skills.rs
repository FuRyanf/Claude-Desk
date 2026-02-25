use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Result;

use crate::models::SkillInfo;

pub fn list_skills(workspace_path: &str) -> Result<Vec<SkillInfo>> {
    let skills_dir = Path::new(workspace_path).join("skills");
    if !skills_dir.exists() {
        return Ok(Vec::new());
    }

    let mut skills = Vec::new();

    for entry in fs::read_dir(skills_dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let skill_md = path.join("SKILL.md");
        if !skill_md.exists() {
            continue;
        }

        let raw = fs::read_to_string(&skill_md)?;
        let (name, description, entry_points) = parse_skill_markdown(&raw);
        let id = path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();

        skills.push(SkillInfo {
            id,
            name,
            description,
            entry_points,
            path: path.to_string_lossy().to_string(),
        });
    }

    skills.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(skills)
}

fn parse_skill_markdown(raw: &str) -> (String, String, Vec<String>) {
    let lines: Vec<&str> = raw.lines().collect();
    let mut name = "Unnamed skill".to_string();
    let mut description = "".to_string();
    let mut entry_points = Vec::new();

    for line in &lines {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            name = trimmed.trim_start_matches('#').trim().to_string();
            break;
        }
    }

    let mut heading_seen = false;
    let mut paragraph_lines = Vec::new();
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
            if !paragraph_lines.is_empty() {
                break;
            }
            continue;
        }
        paragraph_lines.push(trimmed.to_string());
    }
    if !paragraph_lines.is_empty() {
        description = paragraph_lines.join(" ");
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

    (name, description, entry_points)
}

pub fn resolve_enabled_skills_context(
    workspace_path: &str,
    enabled_ids: &[String],
) -> Result<Vec<(String, String)>> {
    let skills_dir = Path::new(workspace_path).join("skills");
    if !skills_dir.exists() {
        return Ok(Vec::new());
    }

    let mut result = Vec::new();
    for skill_id in enabled_ids {
        let skill_file: PathBuf = skills_dir.join(skill_id).join("SKILL.md");
        if !skill_file.exists() {
            continue;
        }
        let raw = fs::read_to_string(&skill_file)?;
        result.push((skill_id.clone(), raw));
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn discovers_skill_markdown_from_workspace_fixture() {
        let workspace =
            std::env::temp_dir().join(format!("claude-desk-skills-test-{}", uuid::Uuid::new_v4()));
        let skill_dir = workspace.join("skills").join("refactor");
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
        assert!(discovered[0]
            .entry_points
            .iter()
            .any(|entry| entry.contains("/skill refactor")));

        let _ = fs::remove_dir_all(workspace);
    }
}
