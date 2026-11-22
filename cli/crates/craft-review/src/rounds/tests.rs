use serde_json::{Value, json};

use super::*;

fn f(title: &str, line: u32) -> Value {
    json!({"severity": "Medium", "title": title, "file": "src/a.rs", "line": line, "source": "model-said", "harmLevel": "outage"})
}

fn lens_task(lens: &str, round: u32, answer: Option<Value>) -> Task {
    profile_task("rust", lens, round, answer)
}

fn profile_task(profile: &str, lens: &str, round: u32, answer: Option<Value>) -> Task {
    let mut t = Task::new(
        format!("lens-{profile}-{lens}-r{round}"),
        "l".into(),
        "p".into(),
        Model::Opus,
        json!({}),
        TaskKind::Lens {
            profile: profile.into(),
            lens: lens.into(),
            round,
            slice: None,
        },
    );
    if let Some(a) = answer {
        t.answer = Some(a);
        t.state = TaskState::Answered;
    } else {
        t.state = TaskState::Failed;
        t.error = Some("it does not match the schema".into());
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
    assert_eq!(dry["rust"], 2);
    assert_eq!(r.pool.len(), 2);
    assert_eq!(r.pool[0]["source"], "errors");
    assert_eq!(r.pool[0]["profile"], "rust");
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
            new_findings: 2,
            raw: Some(3),
        }]
    );
    assert_eq!(r.holes("rust"), ["tests: it does not match the schema"]);
    assert!(r.holes("nix").is_empty());

    r.round = 2;
    let dry = r.absorb(&[
        lens_task(
            "errors",
            2,
            Some(json!({"lens": "x", "findings": [f("A bug", 3)]})),
        ),
        lens_task("tests", 2, Some(json!({"lens": "tests", "findings": []}))),
    ]);
    assert_eq!(dry["rust"], 0, "a round that adds nothing new is dry");
    assert!(
        r.holes("rust").is_empty(),
        "a lens that answered in a later round closed its hole"
    );
    assert_eq!(
        r.pool[0]["foundInRound"], 1,
        "a re-surfaced finding keeps its first round"
    );
}

#[test]
fn a_copy_raised_in_a_later_round_is_counted_raw_and_names_both_rounds() {
    let mut r = Rounds::default();
    for (round, title) in [(1, "A bug"), (2, "a BUG"), (3, "a bug")] {
        r.round = round;
        let answer = json!({"lens": "x", "findings": [f(title, 3)]});
        r.absorb(&[lens_task("errors", round, Some(answer))]);
    }
    assert_eq!(r.pool.len(), 1);
    assert_eq!(
        (
            r.pool[0]["foundInRound"].clone(),
            r.pool[0]["foundInRounds"].clone()
        ),
        (json!(1), json!([1, 2, 3]))
    );
    let raw: Vec<_> = r.yields.iter().map(|y| (y.raw, y.new_findings)).collect();
    assert_eq!(raw, [(Some(1), 1), (Some(1), 0), (Some(1), 0)]);
}

#[test]
fn each_profile_counts_its_own_new_findings_and_holes() {
    let mut r = Rounds {
        round: 1,
        ..Rounds::default()
    };
    let added = r.absorb(&[
        profile_task(
            "rust",
            "errors",
            1,
            Some(json!({"lens": "x", "findings": [f("A", 1)]})),
        ),
        profile_task(
            "general",
            "errors",
            1,
            Some(json!({"lens": "x", "findings": [f("a", 1), f("B", 2)]})),
        ),
        profile_task("nix", "intent", 1, None),
    ]);
    assert_eq!(
        added.into_iter().collect::<Vec<_>>(),
        [("general".into(), 1), ("nix".into(), 0), ("rust".into(), 1)],
        "an exact copy another profile's lens found first is not new to this one"
    );
    assert_eq!(r.holes("nix"), ["intent: it does not match the schema"]);
    assert!(r.holes("general").is_empty() && r.holes("rust").is_empty());
    let plan_of = |lenses: &[&str]| crate::plan::Plan {
        size_bucket: "small".into(),
        lenses: lenses.iter().map(|l| (*l).to_owned()).collect(),
        max_rounds: 1,
        verify_votes: 1,
        is_library: false,
        security_sensitive: false,
        intent: String::new(),
        spec: String::new(),
        churn: Vec::new(),
        repo_rules: Vec::new(),
        surface_dropped: Vec::new(),
        light_skipped: Vec::new(),
        metrics_dropped: Vec::new(),
    };
    assert_eq!(r.ran("general", &plan_of(&["errors", "money"])), ["errors"]);
    assert!(r.ran("nix", &plan_of(&["intent"])).is_empty());
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

/// A Rust lens shown the consumers list carries its lines, so its answer must mark each.
#[test]
fn a_lens_shown_consumer_lines_must_mark_them() {
    use crate::consumers::{Consumers, Listed, Site};
    let site = |line: u32| Site {
        file: "src/api.rs".into(),
        line,
        text: "rule_to_api(r)".into(),
        from: vec!["name search".into()],
        kind: String::new(),
    };
    let ctx = PromptContext {
        consumers: Consumers {
            sources: vec!["name search".into()],
            symbols: vec![Listed {
                name: "rule_to_api".into(),
                file: "src/rule.rs".into(),
                line: 12,
                sites: vec![site(33), site(41)],
            }],
            ..Consumers::default()
        },
        ..PromptContext::fixture("/work/repo", "main")
    };
    let plan = Plan {
        size_bucket: "small".into(),
        lenses: vec!["safety".into()],
        max_rounds: 2,
        verify_votes: 1,
        is_library: false,
        security_sensitive: false,
        intent: String::new(),
        spec: String::new(),
        churn: Vec::new(),
        repo_rules: Vec::new(),
        surface_dropped: Vec::new(),
        light_skipped: Vec::new(),
        metrics_dropped: Vec::new(),
    };
    let rust = Profile::load("rust").unwrap();
    let rounds = Rounds {
        round: 1,
        ..Rounds::default()
    };
    let got = tasks(&ctx, (&rust, &plan), &[], &[], &rounds).unwrap();
    assert_eq!(got[0].marks.consumers, ["src/api.rs:33", "src/api.rs:41"]);
}
