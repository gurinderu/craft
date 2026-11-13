//! The loop on the opencode host, against the stand-in `opencode` of [`super`]: the agent each
//! task runs as, the degraded note when `rust-reviewer` is missing, and the events of the run.

use serde_json::json;

use super::*;

/// Each call's argv, sorted.
fn argvs(bench: &Bench) -> Vec<String> {
    let mut argvs: Vec<String> = std::fs::read_dir(bench.path("log"))
        .unwrap()
        .filter_map(|e| {
            let e = e.unwrap();
            e.file_name()
                .to_string_lossy()
                .starts_with("argv-")
                .then(|| std::fs::read_to_string(e.path()).unwrap().trim().to_owned())
        })
        .collect();
    argvs.sort();
    argvs
}

#[tokio::test]
async fn an_own_task_runs_on_its_agent_bare_and_every_other_on_review_task_with_its_body() {
    let mut bench = Bench::new(HostKind::OpenCode);
    bench.agents = Some(vec!["review-task".into(), "rust-reviewer".into()]);
    let fake = bench.fake(vec![
        Spec("a", "do a", Some("rust-reviewer")),
        Spec("b", "do b", None),
    ]);
    let answer = bench.drive(&fake).await;
    assert!(answer.finished, "{}", answer.text);
    assert_eq!(bench.answer("a"), json!({"answer": "ok"}));
    assert_eq!(
        argvs(&bench),
        [
            "run --format json --agent review-task --model big --archived",
            "run --format json --agent rust-reviewer --model big --archived"
        ]
    );
    assert!(fake.submits.borrow()[0].degraded.is_empty());
    let events = bench.events.borrow();
    assert!(
        events.contains(&Event::Phase {
            name: "lenses".into()
        }),
        "{events:?}"
    );
    assert!(events.contains(&Event::TaskStarted {
        id: "a".into(),
        label: "a".into(),
        agent: Some("rust-reviewer".into()),
        model: Some("big".into()),
        tier: "opus".into()
    }));
    assert!(
        events
            .iter()
            .any(|e| matches!(e, Event::TaskFinished { id, tokens: Some(7), .. } if id == "b")),
        "{events:?}"
    );
}

#[tokio::test]
async fn a_rust_reviewer_task_without_its_agent_runs_on_review_task_said_degraded() {
    let mut bench = Bench::new(HostKind::OpenCode);
    bench.agents = Some(vec!["review-task".into()]);
    let fake = bench.fake(vec![Spec("a", "do a", Some("rust-reviewer"))]);
    let answer = bench.drive(&fake).await;
    assert!(answer.finished, "{}", answer.text);
    assert_eq!(
        argvs(&bench),
        ["run --format json --agent review-task --model big --archived"]
    );
    let messages: Vec<String> = std::fs::read_dir(bench.path(""))
        .unwrap()
        .filter_map(|e| {
            let e = e.unwrap();
            e.file_name()
                .to_string_lossy()
                .starts_with("host.msg-")
                .then(|| std::fs::read_to_string(e.path()).unwrap())
        })
        .collect();
    assert!(
        messages.len() == 1 && messages[0].starts_with("RUBRIC BODY\n\n---\n\n"),
        "{messages:?}"
    );
    let degraded = &fake.submits.borrow()[0].degraded;
    assert_eq!(
        degraded.as_slice(),
        [
            "round 1: 1 task(s) named `rust-reviewer`, an agent this OpenCode does not have, and ran on `review-task` with its prompt body."
        ]
    );
    assert!(bench.events.borrow().contains(&Event::Degraded {
        note: degraded[0].clone()
    }));
}

#[tokio::test]
async fn a_usage_limit_stops_the_round_and_is_an_event() {
    let mut bench = Bench::new(HostKind::OpenCode);
    bench.concurrency = 1;
    let fake = bench.fake(vec![Spec("a", "LIMIT", None), Spec("b", "do b", None)]);
    bench.drive(&fake).await;
    let limit = fake.submits.borrow()[0].limit.clone();
    assert_eq!(
        limit.as_deref(),
        Some("ERROR: You've hit your usage limit. Try again in 3 hours.")
    );
    assert!(bench.events.borrow().contains(&Event::UsageLimit {
        text: limit.unwrap_or_default()
    }));
}

#[tokio::test]
async fn a_worktree_where_opencode_cannot_be_checked_runs_no_task_and_says_why() {
    let mut bench = Bench::new(HostKind::OpenCode);
    bench.agents = Some(vec!["review-task".into()]);
    let worktree = bench.path("worktree");
    std::fs::create_dir_all(&worktree).unwrap();
    let mut fake = bench.fake(vec![Spec("a", "do a", None)]);
    fake.worktree = Some(worktree.clone());
    let answer = bench.drive(&fake).await;
    assert!(!answer.finished, "{}", answer.text);
    assert!(
        answer.text.contains("review cannot run its tasks")
            && answer.text.contains(&worktree.display().to_string())
            && answer.text.contains("install.sh --global"),
        "{}",
        answer.text
    );
    assert!(
        !argvs(&bench).iter().any(|a| a.starts_with("run ")),
        "{:?}",
        argvs(&bench)
    );
    assert!(fake.submits.borrow().is_empty(), "nothing is submitted");
}
