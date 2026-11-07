use serde_json::{Value, json};

use super::*;

fn f(title: &str, line: u32) -> Value {
    json!({"severity": "Medium", "title": title, "file": "src/a.rs", "line": line, "source": "model-said", "harmLevel": "outage"})
}

fn lens_task(lens: &str, round: u32, answer: Option<Value>) -> Task {
    let mut t = Task::new(
        format!("lens-{lens}-r{round}"),
        "l".into(),
        "p".into(),
        Model::Opus,
        json!({}),
        TaskKind::Lens {
            lens: lens.into(),
            round,
        },
    );
    match answer {
        Some(a) => {
            t.answer = Some(a);
            t.state = TaskState::Answered;
        }
        None => {
            t.state = TaskState::Failed;
            t.error = Some("it does not match the schema".into());
        }
    }
    t
}

#[test]
fn the_key_folds_case_and_whitespace() {
    assert_eq!(
        key(&json!({"file": "SRC/A.rs", "line": 3, "title": "  Two   Words "})),
        "src/a.rs:3:two words"
    );
    assert_eq!(key(&json!({})), ":0:");
}

#[test]
fn a_round_pools_new_findings_by_the_dispatched_lens_and_notes_exact_copies() {
    let mut r = Rounds {
        round: 1,
        ..Rounds::default()
    };
    let dry = r.absorb(&[
        lens_task(
            "errors",
            1,
            Some(json!({"lens": "x", "findings": [f("A bug", 3)]})),
        ),
        lens_task(
            "safety",
            1,
            Some(json!({"lens": "x", "findings": [f("a  BUG", 3), f("other", 4)]})),
        ),
        lens_task("tests", 1, None),
    ]);
    assert!(!dry);
    assert_eq!(r.pool.len(), 2);
    assert_eq!(r.pool[0]["source"], "errors");
    assert_eq!(r.pool[0]["foundInRound"], 1);
    assert_eq!(
        r.pool[0]["sources"],
        json!(["errors", "safety"]),
        "the copy's lens is kept"
    );
    assert_eq!(
        r.yields,
        [RoundYield {
            round: 1,
            agents: 3,
            returned: 2,
            new_findings: 2
        }]
    );
    assert_eq!(r.holes(), ["tests: it does not match the schema"]);

    r.round = 2;
    let dry = r.absorb(&[
        lens_task(
            "errors",
            2,
            Some(json!({"lens": "x", "findings": [f("A bug", 3)]})),
        ),
        lens_task("tests", 2, Some(json!({"lens": "tests", "findings": []}))),
    ]);
    assert!(dry, "a round that adds nothing new is dry");
    assert!(
        r.holes().is_empty(),
        "a lens that answered in a later round closed its hole"
    );
    assert_eq!(
        r.pool[0]["foundInRound"], 1,
        "a re-surfaced finding keeps its first round"
    );
}

#[test]
fn the_prior_summary_is_worst_first_and_capped() {
    assert_eq!(prompts::prior_found_summary(&[]), "none yet");
    let pool = [
        json!({"severity": "Low", "file": "a.rs", "line": 1, "title": "low\none"}),
        json!({"severity": "high", "file": "", "line": 0, "title": "high"}),
    ];
    assert_eq!(
        prompts::prior_found_summary(&pool),
        "?:0 high\na.rs:1 low one"
    );
    let many: Vec<Value> = (0..200)
        .map(|i| json!({"severity": "Low", "file": "a.rs", "line": i, "title": "x".repeat(100)}))
        .collect();
    let s = prompts::prior_found_summary(&many);
    assert!(s.chars().count() < 2800, "{}", s.len());
    assert!(s.ends_with("so do not spend effort guessing what is missing from it."));
    assert!(s.contains("… and 177 more already-found finding(s)"), "{s}");
}
