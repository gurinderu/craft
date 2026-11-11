use std::path::{Path, PathBuf};

use super::super::exe::write_executable;
use super::*;

fn task(agent: Option<&str>, consumer: Option<&str>) -> Task {
    Task {
        id: "t".into(),
        label: "t".into(),
        model: "opus".into(),
        prompt_file: PathBuf::from("/p"),
        schema_file: PathBuf::from("/s"),
        answer_file: PathBuf::from("/a"),
        agent_type: agent.map(str::to_owned),
        consumer_agent: consumer.map(str::to_owned),
        kind: None,
    }
}

#[test]
fn a_task_runs_on_its_own_agent_when_listed_else_on_review_task() {
    let both = ["review-task".to_owned(), "rust-reviewer".to_owned()];
    let own = placement(&task(Some("rust-reviewer"), None), Some(&both));
    assert_eq!(
        (own.agent.as_str(), own.own, own.degraded),
        ("rust-reviewer", true, None)
    );
    let unknown = placement(&task(Some("rust-reviewer"), None), None);
    assert!(unknown.own);
    let lacking = placement(&task(Some("rust-reviewer"), None), Some(&both[..1]));
    assert_eq!(
        (
            lacking.agent.as_str(),
            lacking.own,
            lacking.degraded.as_deref()
        ),
        ("review-task", false, Some("rust-reviewer"))
    );
    let other = placement(&task(Some("nix-reviewer"), None), Some(&both));
    assert_eq!(
        (other.agent.as_str(), other.degraded),
        ("review-task", None)
    );
    let consumer = placement(&task(Some("rust-reviewer"), Some("mine")), Some(&both));
    assert_eq!(
        (consumer.agent.as_str(), consumer.degraded),
        ("review-task", None)
    );
}

#[test]
fn the_major_version_is_read_from_either_lines_words() {
    assert_eq!(major_of("opencode v2.2.7\n"), Some(2));
    assert_eq!(major_of("1.19.5"), Some(1));
    assert_eq!(major_of("opencode"), None);
}

/// A stand-in opencode that says `version` and lists `agents` (a JSON array of ids).
fn fake(dir: &Path, version: &str, agents: &str) -> PathBuf {
    let path = dir.join("opencode");
    let list = agents
        .split(',')
        .filter(|a| !a.is_empty())
        .map(|a| format!(r#"{{"id":"{a}","hidden":true}}"#))
        .collect::<Vec<_>>()
        .join(",");
    let script = format!(
        "#!/bin/sh\ncase \"$1\" in --version) echo '{version}';; debug) echo '[{list}]';; *) exit 9;; esac\n"
    );
    write_executable(&path, &script).unwrap();
    path
}

#[test]
fn a_2x_opencode_with_review_task_is_ready_and_its_agents_read() {
    let dir = tempfile::tempdir().unwrap();
    let oc = fake(
        dir.path(),
        "opencode v2.2.7",
        "build,review-task,rust-reviewer",
    );
    let got = preflight(&oc, dir.path(), &|_| {}).unwrap();
    assert_eq!(
        got,
        Some(vec![
            "build".into(),
            "review-task".into(),
            "rust-reviewer".into()
        ])
    );
}

#[test]
fn a_1x_opencode_or_one_without_review_task_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let old = fake(dir.path(), "1.19.5", "review-task");
    let why = preflight(&old, dir.path(), &|_| {}).unwrap_err();
    assert!(why.contains("1.x opencode"), "{why}");
    let bare = fake(dir.path(), "opencode v2.2.7", "build");
    let why = preflight(&bare, dir.path(), &|_| {}).unwrap_err();
    assert!(
        why.contains("rerun integrations/opencode/install.sh"),
        "{why}"
    );
}

#[test]
fn an_unreadable_agent_list_is_said_and_no_refusal() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("opencode");
    write_executable(
        &path,
        "#!/bin/sh\ncase \"$1\" in --version) echo 'opencode v2.2.7';; *) echo down >&2; exit 1;; esac\n",
    )
    .unwrap();
    let heard = std::cell::RefCell::new(Vec::new());
    let got = preflight(&path, dir.path(), &|l| {
        heard.borrow_mut().push(l.to_owned())
    })
    .unwrap();
    assert_eq!(got, None);
    assert!(heard.borrow()[0].contains("down"), "{:?}", heard.borrow());
}
