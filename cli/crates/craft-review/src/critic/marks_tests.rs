//! A lens the critic admits is shown the CONSUMERS block like any lens: it is held to marking the
//! lines it was shown, and the lines it leaves reach the run's unmarked lines.

use serde_json::json;

use super::admit::followups;
use super::fresh;
use super::tests::{plan, run_with};
use crate::consumers::{Consumers, Listed, Site};
use crate::profile::Profile;
use crate::state::{Task, TaskKind, TaskState};

/// A list of one symbol named at `src/b.rs:3`.
fn listed() -> Consumers {
    Consumers {
        sources: vec!["name search".into()],
        symbols: vec![Listed {
            name: "rule_to_api".into(),
            file: "src/lib.rs".into(),
            line: 1,
            sites: vec![Site {
                file: "src/b.rs".into(),
                line: 3,
                text: "rule_to_api(x)".into(),
                from: vec!["name search".into()],
                kind: String::new(),
            }],
        }],
        ..Consumers::default()
    }
}

#[test]
fn an_admitted_lens_is_held_to_the_consumers_lines_its_prompt_shows() {
    let profiles = vec![Profile::rust().unwrap()];
    let mut run = run_with(&plan("large", false, &["errors"], &[]));
    run.context.consumers = listed();
    let mut critic = Task::new(
        "critic-rust".into(),
        "critic:rust".into(),
        String::new(),
        crate::agent::Model::Opus,
        json!({}),
        TaskKind::Critic {
            profile: "rust".into(),
        },
    );
    critic.state = TaskState::Answered;
    critic.answer = Some(json!({"missingLenses": ["safety"], "notes": ""}));
    run.tasks = vec![critic];
    let lenses = followups(&mut run, &profiles).unwrap();
    assert!(
        lenses[0].prompt.contains("- src/b.rs:3: "),
        "{}",
        lenses[0].prompt
    );
    assert_eq!(lenses[0].consumers, ["src/b.rs:3"]);
}

#[test]
fn the_lines_an_admitted_lens_left_unmarked_are_the_run_s() {
    let mut run = run_with(&plan("large", false, &["errors"], &[]));
    let lens = |id: &str, unmarked: &[&str]| {
        let mut t = Task::new(
            id.into(),
            id.into(),
            String::new(),
            crate::agent::Model::Opus,
            json!({}),
            TaskKind::CriticLens {
                profile: "rust".into(),
                lens: id.into(),
            },
        );
        t.state = TaskState::Answered;
        t.answer = Some(json!({"findings": []}));
        t.consumers = vec!["src/b.rs:3".into(), "src/c.rs:4".into()];
        t.unmarked = unmarked.iter().map(|s| (*s).to_owned()).collect();
        t
    };
    run.tasks = vec![
        lens("safety", &["src/b.rs:3", "src/c.rs:4"]),
        lens("concurrency", &["src/b.rs:3"]),
    ];
    fresh(&mut run);
    assert_eq!(run.rounds.unmarked(), ["src/b.rs:3"]);
}
