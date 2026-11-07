use serde_json::{Value, json};

use super::*;
use crate::agent::Model;
use crate::state::{Task, TaskKind, TaskState};

fn row(title: &str, rule: &str, disposition: &str, tier: &str) -> LedgerRow {
    LedgerRow {
        file: "src/lib.rs".into(),
        line: 3,
        severity: "High".into(),
        tier: tier.into(),
        disposition: disposition.into(),
        rule_id: rule.into(),
        title: title.into(),
        why: "w".into(),
        ..LedgerRow::default()
    }
}

/// A chain built on a prior round whose ledger is `rows`.
fn chained(rows: Vec<LedgerRow>) -> Chain {
    let mut c = Chain {
        round: 2,
        prior: Some(PriorRun {
            dir: "/r1".into(),
            round: 1,
            head: "abc".into(),
        }),
        ..Chain::default()
    };
    take_ledger(&mut c, rows);
    c
}

fn adjudicated(prior: usize, answer: Option<Value>) -> Task {
    let mut t = Task::new(
        format!("adjudicate-{prior}"),
        "a".into(),
        "p".into(),
        Model::Opus,
        json!({}),
        TaskKind::Adjudicate { prior },
    );
    t.state = if answer.is_some() {
        TaskState::Answered
    } else {
        TaskState::Failed
    };
    t.answer = answer;
    t
}

fn said(status: &str, line: i64, attack: &str) -> Option<Value> {
    Some(
        json!({"status": status, "currentLine": line, "note": "n", "invariant": "i", "attack": attack}),
    )
}

#[test]
fn the_prior_ledger_splits_into_findings_to_judge_carry_and_tombstones() {
    let c = chained(vec![
        row("a", "R1", "open", "confirmed"),
        row("b", "R2", "open", "unverified"),
        row("c", "R3", "rejected", "confirmed"),
        row("d", "R4", "closed", "confirmed"),
    ]);
    let fates: Vec<Fate> = c.priors.iter().map(|p| p.fate).collect();
    assert_eq!(fates, [Fate::Pending, Fate::Unverified, Fate::Carried]);
    assert_eq!(c.tombstones.len(), 1);
}

#[test]
fn each_answer_gives_its_prior_a_fate_and_a_dead_adjudicator_keeps_it_open() {
    let mut c = chained(
        ["a", "b", "c", "d", "e", "f"]
            .iter()
            .map(|t| row(t, t, "open", "confirmed"))
            .collect(),
    );
    let tasks = [
        adjudicated(0, said("resolved", 9, "")),
        adjudicated(1, said("resolved", 0, "x breaks it")),
        adjudicated(2, said("still-open", 0, "")),
        adjudicated(3, said("regressed", 0, "a new hole")),
        adjudicated(4, said("cannot-tell", 0, "")),
        adjudicated(5, None),
    ];
    let notes = judge(&mut c, &tasks);
    let fates: Vec<Fate> = c.priors.iter().map(|p| p.fate).collect();
    assert_eq!(
        fates,
        [
            Fate::Resolved,
            Fate::StillOpen,
            Fate::StillOpen,
            Fate::Regressed,
            Fate::StillOpen,
            Fate::StillOpen
        ]
    );
    let whys: Vec<&str> = c.priors.iter().map(|p| p.row.why.as_str()).collect();
    assert_eq!(c.priors[0].row.line, 9);
    assert_eq!(whys[1], "w — fix incomplete: x breaks it");
    assert_eq!(whys[3], "w — REGRESSED after fix: a new hole");
    assert!(whys[4].starts_with("w — UNVERIFIED"), "{}", whys[4]);
    assert!(whys[5].starts_with("w — still-open (adjudicator did not run"));
    assert_eq!(notes.len(), 1, "{notes:?}");
    // A later round's marker replaces this one's rather than piling on.
    let mut again = chained(vec![c.priors[1].row.clone()]);
    judge(
        &mut again,
        &[adjudicated(0, said("still-open", 0, "y too"))],
    );
    assert_eq!(again.priors[0].row.why, "w — fix incomplete: y too");
    assert_eq!(c.gating().len(), 5);
}

/// A settled finding of `rule` at `src/lib.rs:<line>`.
fn settled(rule: &str, line: i64, severity: &str, tier: &str) -> Value {
    json!({"file": "src/lib.rs", "line": line, "ruleId": rule, "title": format!("{rule} at {line}"),
           "why": "y", "severity": severity, "tier": tier})
}

#[test]
fn a_verified_repeat_is_absorbed_onto_its_prior_and_a_returning_one_is_marked() {
    let mut c = chained(vec![
        row("open one", "R1", "open", "confirmed"),
        row("fixed one", "R2", "closed", "confirmed"),
    ]);
    c.tombstones[0].why = "resolved in round 4".into();
    let mut found = vec![
        settled("R1", 3, "High", "confirmed"),
        settled("R2", 5, "High", "suspected"),
        settled("R2", 6, "High", "refuted"),
        settled("R9", 7, "High", "confirmed"),
    ];
    let notes = absorb(&mut c, &mut found);
    assert_eq!(found.len(), 3);
    assert_eq!((c.absorbed, c.regressions, notes.len()), (1, 1, 2));
    assert_eq!(
        c.priors[0].row.why, "w — also reported at src/lib.rs:3: R1 at 3",
        "absorbed is not discarded: the site rides the prior's rationale"
    );
    assert!(
        found[0]["why"]
            .as_str()
            .unwrap()
            .ends_with("resolved in round 4 and has reappeared."),
        "{}",
        found[0]
    );
    assert_eq!(
        found[1]["why"],
        json!("y"),
        "a refuted finding is no regression"
    );
    let mut first = Chain::default();
    let mut kept = vec![settled("R1", 3, "High", "confirmed")];
    assert!(absorb(&mut first, &mut kept).is_empty());
    assert_eq!(kept.len(), 1);
}

#[test]
fn a_more_severe_finding_or_one_at_another_site_is_never_swallowed() {
    let mut low = row("a low one", "R1", "open", "confirmed");
    low.severity = "Low".into();
    let mut c = chained(vec![low, row("set aside", "R2", "rejected", "confirmed")]);
    let mut found = vec![
        settled("R1", 9, "Critical", "confirmed"),
        settled("R1", 3, "Critical", "confirmed"),
        settled("R2", 40, "Medium", "confirmed"),
    ];
    let notes = absorb(&mut c, &mut found);
    assert_eq!(found.len(), 3, "{found:?}");
    assert_eq!(c.absorbed, 0);
    assert!(notes.iter().any(|n| n.contains("more severe")), "{notes:?}");
    assert_eq!(c.priors[1].row.why, "w", "the carried prior took nothing");
}

#[test]
fn an_unverified_prior_hosts_nothing_and_an_unverified_finding_is_not_absorbed() {
    let mut c = chained(vec![
        row("never checked", "R1", "open", "unverified"),
        row("open", "R2", "open", "confirmed"),
    ]);
    let mut found = vec![
        settled("R1", 3, "High", "confirmed"),
        settled("R2", 3, "High", "unverified"),
    ];
    absorb(&mut c, &mut found);
    assert_eq!((found.len(), c.absorbed), (2, 0));
}

#[test]
fn the_ledger_carries_the_open_the_settled_and_the_tombstones() {
    let mut c = chained(vec![
        row("a", "R1", "open", "confirmed"),
        row("b", "R2", "open", "suspected"),
        row("c", "R3", "justified", "confirmed"),
        row("d", "R4", "closed", "confirmed"),
    ]);
    judge(
        &mut c,
        &[
            adjudicated(0, said("resolved", 0, "")),
            adjudicated(1, said("still-open", 0, "")),
        ],
    );
    let settled = [
        json!({"severity": "Low", "title": "new", "file": "b.rs", "line": 1, "tier": "confirmed"}),
        json!({"severity": "Low", "title": "gone", "file": "b.rs", "line": 2, "tier": "refuted"}),
    ];
    let rows = ledger(&c, &settled);
    let seen: Vec<(&str, &str)> = rows
        .iter()
        .map(|r| (r.title.as_str(), r.disposition.as_str()))
        .collect();
    assert_eq!(
        seen,
        [
            ("new", "open"),
            ("b", "open"),
            ("c", "justified"),
            ("d", "closed"),
            ("a", "closed")
        ]
    );
    assert_eq!(rows[4].why, "resolved in round 2");
    c.tombstones = vec![row("t", "R", "closed", "confirmed"); TOMBSTONES_MAX + 5];
    let capped = ledger(&c, &[]);
    assert_eq!(
        capped.iter().filter(|r| r.disposition == "closed").count(),
        TOMBSTONES_MAX
    );
}
