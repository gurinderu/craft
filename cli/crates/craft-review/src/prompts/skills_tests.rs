//! Every skill a task prompt names reaches its agent as an absolute path to a readable file, for
//! every prompt template (each task kind's) and every profile's rubrics; a run that cannot name
//! one says so in the prompt and in the report.

use std::path::{Path, PathBuf};

use super::{block, mentioned, unresolved};
use crate::profile::Profile;
use crate::prompts::PromptContext;
use crate::state::{Task, TaskKind};

/// The checkout's Claude Code delivery, the plugin root a checkout run names.
fn delivery() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../integrations/claude-code")
}

fn ctx(root: Option<&Path>) -> PromptContext {
    PromptContext {
        craft_root: root.map(|r| r.display().to_string()),
        ..PromptContext::fixture("/work/repo", "origin/main")
    }
}

/// Every prompt template under `content/prompts`, with its name.
fn templates() -> Vec<(String, String)> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content/prompts");
    let mut out = Vec::new();
    for sub in [dir.clone(), dir.join("lens-briefs")] {
        for entry in std::fs::read_dir(&sub).expect("prompts dir") {
            let path = entry.expect("entry").path();
            if path.extension().is_some_and(|e| e == "md") {
                let text = std::fs::read_to_string(&path).expect("template");
                out.push((path.display().to_string(), text));
            }
        }
    }
    assert!(out.len() > 40, "the prompt templates were not found");
    out
}

/// Each template as each profile's lenses fill it: the rubric, the navigation skill, the exclusion file.
fn rendered() -> Vec<(String, String)> {
    let mut out = Vec::new();
    for profile in Profile::all().expect("profiles") {
        let nav = if profile.nav_skill.is_empty() {
            String::new()
        } else {
            format!(" and the {} skill for context expansion", profile.nav_skill)
        };
        for lens in profile.roster() {
            for (name, text) in templates() {
                let text = text
                    .replace("{{rubricSkill}}", profile.rubric_of(&lens))
                    .replace("{{navLoad}}", &nav)
                    .replace("{{fpRules}}", profile.fp_rules_of(&lens));
                out.push((format!("{name} ({}:{lens})", profile.id), text));
            }
        }
    }
    out
}

#[test]
fn every_skill_a_rendered_prompt_names_is_an_absolute_path_to_a_readable_file() {
    let root = delivery();
    let ctx = ctx(Some(&root));
    let mut named = 0;
    for (name, text) in rendered() {
        let block = block(&ctx, &text);
        for skill in mentioned(&text) {
            // A word that is no skill of the plugin ("the owning skill") is prose, not a rubric.
            if !root.join("skills").join(&skill).exists() {
                continue;
            }
            named += 1;
            let line = block
                .lines()
                .find(|l| l.starts_with(&format!("- `{skill}`: `")))
                .unwrap_or_else(|| panic!("{name}: `{skill}` has no path in {block:?}"));
            let path = line.split('`').nth(3).expect("a path");
            assert!(Path::new(path).is_absolute(), "{name}: {path}");
            assert!(Path::new(path).is_file(), "{name}: {path} is not readable");
        }
        assert!(!block.contains("no absolute path"), "{name}: {block}");
    }
    assert!(named > 100, "too few skills named: {named}");
}

#[test]
fn every_skill_the_templates_name_is_a_skill_the_plugin_ships() {
    let root = delivery();
    for (name, text) in rendered() {
        for skill in mentioned(&text) {
            assert!(
                root.join("skills").join(&skill).join("SKILL.md").is_file(),
                "{name} names `{skill}`, which the plugin does not ship"
            );
        }
    }
}

#[test]
fn without_a_root_the_prompt_says_so_and_the_run_is_named_degraded() {
    let text = "Load the sql-review skill for the rubric.";
    for ctx in [ctx(None), ctx(Some(Path::new("/nowhere/craft")))] {
        let block = block(&ctx, text);
        assert!(
            block.contains("- `sql-review`: no absolute path is known"),
            "{block}"
        );
        assert!(
            block.contains("the report names this run as degraded"),
            "{block}"
        );
        let task = Task::new(
            "lens".into(),
            "lens".into(),
            text.into(),
            crate::agent::Model::Opus,
            serde_json::json!({}),
            TaskKind::Dedup,
        );
        assert_eq!(unresolved(&ctx, &[task]), ["sql-review"]);
    }
    assert_eq!(block(&ctx(None), "No skill here."), "");
}
