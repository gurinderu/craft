use std::path::{Path, PathBuf};

use super::*;
use crate::run::models::{ModelTable, thinking_table};

fn host(kind: HostKind) -> Host {
    let models: ModelTable = [("opus".to_owned(), "big".to_owned())]
        .into_iter()
        .collect();
    Host {
        kind,
        models,
        thinking: thinking_table("", "--thinking").unwrap(),
        command: PathBuf::from("x"),
        agents: None,
        archived: true,
    }
}

fn task(dir: &Path, prompt: &str) -> Task {
    std::fs::write(dir.join("t.md"), prompt).unwrap();
    std::fs::write(dir.join("t.schema.json"), r#"{"type": "object"}"#).unwrap();
    Task {
        id: "t".into(),
        label: "t".into(),
        model: "sonnet".into(),
        prompt_file: dir.join("t.md"),
        schema_file: dir.join("t.schema.json"),
        answer_file: dir.join("a.json"),
        agent_type: None,
        consumer_agent: None,
        kind: None,
    }
}

#[test]
fn a_codex_task_reads_its_prompt_after_the_body_with_its_schema_and_tiers_model() {
    let dir = tempfile::tempdir().unwrap();
    let mut t = task(dir.path(), "Look at ${CLAUDE_PLUGIN_ROOT}/x.\n");
    let root = Path::new("/plugin");
    let r = host(HostKind::Codex)
        .request(&t, "BODY", (root, dir.path()))
        .unwrap();
    assert!(r.prompt.starts_with("BODY\n\n---\n\n"), "{}", r.prompt);
    assert!(
        r.prompt
            .contains("Look at /plugin/x.\n\nYour final message is your answer")
    );
    assert!(r.prompt.trim_end().ends_with("read it from there."));
    assert_eq!(r.schema, Some(serde_json::json!({"type": "object"})));
    assert_eq!(r.thinking, None, "only pi is given a thinking level");
    assert_eq!(
        r.model, None,
        "a tier the table does not map runs on the host's own"
    );
    t.model = "opus".into();
    let r = host(HostKind::Codex)
        .request(&t, "", (root, dir.path()))
        .unwrap();
    assert_eq!(r.model.as_deref(), Some("big"));
    assert!(r.prompt.starts_with("Look at"));
}

#[test]
fn a_pi_task_reads_a_copy_of_its_prompt_with_the_root_written_in() {
    let dir = tempfile::tempdir().unwrap();
    let t = task(dir.path(), "Look at ${CLAUDE_PLUGIN_ROOT}/x.");
    let r = host(HostKind::Pi)
        .request(&t, "", (Path::new("/plugin"), dir.path()))
        .unwrap();
    let copy = dir.path().join("t.pi.md");
    assert_eq!(
        std::fs::read_to_string(&copy).unwrap(),
        "Look at /plugin/x."
    );
    assert!(
        r.prompt
            .starts_with(&format!("Read the file {} and do", copy.display()))
    );
    assert!(r.prompt.contains("```craft-answer"));
    assert_eq!(r.schema, None);
    let plain = task(dir.path(), "No root here.");
    let r = host(HostKind::Pi)
        .request(&plain, "", (Path::new("/plugin"), dir.path()))
        .unwrap();
    assert!(r.prompt.contains(&plain.prompt_file.display().to_string()));
}

#[test]
fn a_pi_task_thinks_by_its_tier_unless_its_model_names_a_level() {
    let dir = tempfile::tempdir().unwrap();
    let mut t = task(dir.path(), "x");
    let mut pi = host(HostKind::Pi);
    let level = |pi: &Host, t: &Task| {
        pi.request(t, "", (Path::new("/p"), dir.path()))
            .unwrap()
            .thinking
    };
    for (tier, want) in [("opus", "high"), ("sonnet", "medium"), ("haiku", "low")] {
        t.model = tier.into();
        assert_eq!(level(&pi, &t).as_deref(), Some(want), "{tier}");
    }
    pi.thinking = thinking_table("sonnet=max", "--thinking").unwrap();
    t.model = "sonnet".into();
    assert_eq!(level(&pi, &t).as_deref(), Some("max"));
    pi.models
        .insert("sonnet".into(), "anthropic/claude-x:minimal".into());
    assert_eq!(level(&pi, &t), None, "the model's own level wins");
    pi.models.insert("sonnet".into(), "ollama/llama3:8b".into());
    assert_eq!(level(&pi, &t).as_deref(), Some("max"));
}

#[test]
fn a_missing_login_is_named_with_how_to_log_in() {
    let said = "ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: x";
    assert_eq!(
        host(HostKind::Codex).not_logged_in(said).unwrap(),
        "Codex is not logged in (401 Unauthorized: Missing bearer or basic authentication in header): log in to Codex — run `codex login` — then resume the run"
    );
    assert!(
        host(HostKind::Pi)
            .not_logged_in("No API key found for openai")
            .unwrap()
            .contains("run `pi` and `/login`")
    );
    assert_eq!(host(HostKind::Pi).not_logged_in("boom"), None);
}

#[test]
fn an_unreadable_prompt_is_said() {
    let dir = tempfile::tempdir().unwrap();
    let mut t = task(dir.path(), "x");
    t.prompt_file = dir.path().join("gone.md");
    let why = host(HostKind::Codex)
        .request(&t, "", (Path::new("/p"), dir.path()))
        .unwrap_err();
    assert!(why.contains("could not be read"), "{why}");
}
