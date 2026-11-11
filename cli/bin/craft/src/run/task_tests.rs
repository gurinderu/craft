use std::path::Path;

use serde_json::json;

use super::*;

fn task(agent: Option<&str>, consumer: Option<&str>) -> Task {
    Task {
        id: "t1".into(),
        label: "t1".into(),
        model: "opus".into(),
        prompt_file: "/run/tasks/t1.md".into(),
        schema_file: "/run/tasks/t1.schema.json".into(),
        answer_file: "/run/answers/t1.json".into(),
        agent_type: agent.map(str::to_owned),
        consumer_agent: consumer.map(str::to_owned),
        kind: None,
    }
}

#[test]
fn a_step_task_is_read_and_a_malformed_one_refused() {
    let step = json!({"tasks": [{"id": "a", "label": "A", "model": "haiku", "promptFile": "/p", "schemaFile": "/s", "answerFile": "/a", "kind": "lens"}]});
    let tasks = tasks_of(&step).unwrap();
    assert_eq!(tasks[0].kind.as_deref(), Some("lens"));
    assert_eq!(tasks[0].agent_type, None);
    let relative = json!({"tasks": [{"id": "a", "label": "A", "model": "haiku", "promptFile": "p", "schemaFile": "/s", "answerFile": "/a"}]});
    tasks_of(&relative).unwrap_err();
    tasks_of(&json!({"tasks": []})).unwrap_err();
}

#[test]
fn the_rubric_is_crafts_agent_or_the_consumers_its_frontmatter_cut() {
    let root = tempfile::tempdir().unwrap();
    let repo = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(root.path().join("agents")).unwrap();
    std::fs::write(
        root.path().join("agents/rust-reviewer.md"),
        "---\nname: rust-reviewer\n---\n\nReview Rust.\n",
    )
    .unwrap();
    std::fs::create_dir_all(repo.path().join(".claude/agents")).unwrap();
    std::fs::write(repo.path().join(".claude/agents/mine.md"), "Mine.").unwrap();
    let (r, p) = (root.path(), repo.path());
    let got = rubric_of(&task(Some("rust-reviewer"), None), r, p);
    assert_eq!(got.body, "Review Rust.");
    assert_eq!(got.missing(), "");
    assert_eq!(rubric_of(&task(None, Some("mine")), r, p).body, "Mine.");
    let gone = rubric_of(&task(Some("nix-reviewer"), None), r, p);
    assert_eq!(gone.missing(), "nix-reviewer");
    assert_eq!(rubric_of(&task(Some("../x"), None), r, p).body, "");
    assert_eq!(rubric_of(&task(None, None), r, p), Rubric::default());
}

#[test]
fn the_root_is_written_in_and_the_skills_are_named_as_files() {
    let root = Path::new("/plugin");
    assert_eq!(
        spell_root("read ${CLAUDE_PLUGIN_ROOT}/skills/x", root),
        "read /plugin/skills/x"
    );
    assert!(skill_line(root).contains("/plugin/skills/<name>/SKILL.md"));
    assert_eq!(headed("", "task"), "task");
    assert!(headed("body", "task").starts_with("body\n\n---\n\nThe task below is your whole task"));
}
