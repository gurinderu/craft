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
    take_ledger(&mut c, rows, &|_| false);
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
        row("e", "R5", "rejected", "unverified"),
        row("f", "R6", "justified", "suspected"),
        row("g", "R7", "deferred", "confirmed"),
        row("h", "R8", "covered", "confirmed"),
    ]);
    let fates: Vec<Fate> = c.priors.iter().map(|p| p.fate).collect();
    assert_eq!(
        fates,
        [
            Fate::Pending,
            Fate::Unverified,
            Fate::Carried,
            Fate::Unverified,
            Fate::Carried,
            Fate::Pending,
            Fate::Pending
        ],
        "the unverified tier first, whatever the disposition; only rejected and justified carry-checked"
    );
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
    judge(&mut c, &[adjudicated(0, said("still-open", 3, ""))]);
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
fn a_more_severe_finding_or_one_beside_a_relocated_prior_is_never_swallowed() {
    let mut low = row("a low one", "R1", "open", "confirmed");
    low.severity = "Low".into();
    let mut c = chained(vec![low, row("open high", "R3", "open", "confirmed")]);
    judge(
        &mut c,
        &[
            adjudicated(0, said("still-open", 3, "")),
            adjudicated(1, said("still-open", 3, "")),
        ],
    );
    let mut found = vec![
        settled("R1", 9, "Critical", "confirmed"),
        settled("R1", 3, "Critical", "confirmed"),
        settled("R3", 9, "Medium", "confirmed"),
    ];
    let notes = absorb(&mut c, &mut found);
    assert_eq!(found.len(), 3, "{found:?}");
    assert_eq!(c.absorbed, 0);
    assert!(notes.iter().any(|n| n.contains("more severe")), "{notes:?}");
    assert_eq!(
        c.priors[1].row.why, "w",
        "a relocated prior takes nothing from another site"
    );
}

/// The carry-check of prior `prior`: `changed`, or `None` for a check that gave no answer.
fn carried(prior: usize, changed: Option<bool>) -> Task {
    let mut t = adjudicated(prior, changed.map(|c| json!({"changed": c, "reason": "r"})));
    t.kind = TaskKind::CarryCheck { prior };
    t
}

/// A rejected High of rule `R2` at `src/lib.rs:40`.
fn rejected_at_40() -> Chain {
    let mut set_aside = row("rejected high", "R2", "rejected", "confirmed");
    set_aside.line = 40;
    chained(vec![set_aside])
}

#[test]
fn a_set_aside_prior_swallows_no_judged_finding_whatever_its_carry_check_says() {
    for check in [Some(false), None] {
        let mut c = rejected_at_40();
        judge(&mut c, &[carried(0, check)]);
        let mut found = vec![settled("R2", 200, "High", "confirmed")];
        absorb(&mut c, &mut found);
        assert_eq!(
            (found.len(), c.absorbed),
            (1, 0),
            "{check:?}: the new High stays and gates"
        );
        assert_eq!(c.priors[0].row.why, "w");
    }
}

#[test]
fn an_unchanged_set_aside_prior_retires_and_its_re_raise_is_marked_next_round() {
    let mut c = rejected_at_40();
    judge(&mut c, &[carried(0, Some(false))]);
    assert_eq!(c.priors[0].fate, Fate::Retired);
    assert!(
        c.gating().is_empty(),
        "the author's rejection holds no verdict"
    );
    let rows = ledger(&c, &[]);
    assert_eq!(
        (rows[0].disposition.as_str(), rows[0].why.as_str()),
        ("closed", "dismissed in round 2")
    );
    let mut next = chained(rows);
    let mut found = vec![settled("R2", 52, "High", "confirmed")];
    let notes = absorb(&mut next, &mut found);
    assert!(
        found[0]["why"]
            .as_str()
            .unwrap()
            .ends_with("the author dismissed in round 2 has been re-raised."),
        "{}",
        found[0]
    );
    assert_eq!(
        next.regressions, 0,
        "a re-raised dismissal is no regression"
    );
    assert!(notes.iter().any(|n| n.contains("re-raised")), "{notes:?}");
}

#[test]
fn a_changed_set_aside_prior_reopens_and_takes_its_re_report_at_a_moved_line() {
    let mut c = rejected_at_40();
    judge(&mut c, &[carried(0, Some(true))]);
    let p = &c.priors[0];
    assert_eq!(
        (p.fate, p.row.disposition.as_str()),
        (Fate::StillOpen, "open")
    );
    assert!(p.row.why.ends_with("(reopened: dismissed as rejected, but the code around it changed — re-verify the justification)"));
    assert_eq!(c.gating().len(), 1, "reopened, it counts by its severity");
    let mut found = vec![settled("R2", 52, "High", "confirmed")];
    absorb(&mut c, &mut found);
    assert!(found.is_empty(), "{found:?}");
    assert!(
        c.priors[0]
            .row
            .why
            .starts_with("w — also reported at src/lib.rs:52: R2 at 52 (reopened")
    );
    assert_eq!(ledger(&c, &found).len(), 1, "no row is added on a re-scan");
    let mut again = chained(ledger(&c, &found));
    judge(&mut again, &[adjudicated(0, said("still-open", 0, ""))]);
    assert!(
        !again.priors[0].located,
        "currentLine 0 is not found: the old line, the file-and-rule key"
    );
    assert!(
        again.priors[0].row.why.starts_with("w — also reported at"),
        "{}",
        again.priors[0].row.why
    );
}

#[test]
fn an_unverified_prior_hosts_no_judged_finding_and_tracks_an_unverified_one() {
    let mut c = chained(vec![
        row("never checked", "R1", "open", "unverified"),
        row("open", "R2", "open", "confirmed"),
    ]);
    let mut found = vec![
        settled("R1", 3, "High", "confirmed"),
        settled("R2", 3, "High", "unverified"),
        settled("R1", 8, "Low", "unverified"),
    ];
    let notes = absorb(&mut c, &mut found);
    assert_eq!(
        (found.len(), c.absorbed),
        (3, 0),
        "every one stays in the report"
    );
    assert!(
        c.priors[0]
            .row
            .why
            .ends_with("also reported at src/lib.rs:8: R1 at 8")
    );
    assert_eq!(
        c.priors[1].row.why, "w",
        "a judged prior tracks nothing unchecked"
    );
    assert!(
        notes.iter().any(|n| n.contains("not given a second row")),
        "{notes:?}"
    );
    let rows = ledger(&c, &found);
    assert_eq!(
        rows.len(),
        4,
        "the tracked one gets no row of its own: {rows:?}"
    );
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

/// Every fate a prior can meet, at every tier, located or not.
fn every_prior() -> Vec<PriorFinding> {
    let fates = [
        Fate::Pending,
        Fate::Resolved,
        Fate::StillOpen,
        Fate::Regressed,
        Fate::Carried,
        Fate::Unverified,
        Fate::Retired,
    ];
    let mut out = Vec::new();
    for fate in fates {
        for tier in ["confirmed", "suspected", "unverified"] {
            for located in [false, true] {
                out.push(PriorFinding {
                    row: row("p", "R1", "open", tier),
                    fate,
                    located,
                    contradicts: None,
                });
            }
        }
    }
    out
}

#[test]
fn a_finding_is_absorbed_only_into_a_prior_that_gates_this_run() {
    for prior in every_prior() {
        let mut c = chained(Vec::new());
        c.priors = vec![prior.clone()];
        for tier in ["confirmed", "suspected", "unverified", "refuted"] {
            let mut found = vec![settled("R1", 3, "Low", tier)];
            let before = c.absorbed;
            absorb(&mut c, &mut found);
            let host = &c.priors[0];
            if c.absorbed > before {
                assert!(
                    host.gates(),
                    "{prior:?} absorbed a {tier} finding without gating"
                );
            }
            let judged = matches!(tier, "confirmed" | "suspected");
            assert_eq!(
                c.absorbed > before,
                judged && host.gates(),
                "{prior:?}: a {tier} finding"
            );
        }
    }
}

#[test]
fn an_absorbed_host_comes_back_next_round_to_be_adjudicated_with_its_absorbed_site() {
    let mut c = chained(vec![row("open one", "R1", "open", "confirmed")]);
    judge(
        &mut c,
        &[adjudicated(0, said("still-open", 3, "still there"))],
    );
    let mut found = vec![settled("R1", 3, "Medium", "confirmed")];
    absorb(&mut c, &mut found);
    assert_eq!(c.absorbed, 1);
    // Filed as round.json files it, and read back by the next round.
    let filed = serde_json::to_string(&ledger(&c, &found)).unwrap();
    let next = chained(serde_json::from_str(&filed).unwrap());
    assert_eq!(next.priors[0].fate, Fate::Pending);
    let ctx = crate::prompts::PromptContext {
        strict: false,
        repo: "/r".into(),
        base: "abc".into(),
        spec: String::new(),
        craft_root: None,
        craft_version: None,
        re_review: crate::prompts::ReScope::Fixes,
        sources: crate::sources::Sources::default(),
    };
    let profiles = crate::profile::Profile::all().unwrap();
    let t = tasks(&ctx, &next, &profiles).unwrap();
    assert_eq!(t.len(), 1);
    assert_eq!(t[0].kind, TaskKind::Adjudicate { prior: 0 });
    let p = &t[0].prompt;
    assert!(
        p.contains("ALSO REPORTED AT THIS SITE") && p.contains("  - src/lib.rs:3: R1 at 3"),
        "{p}"
    );
    assert!(
        p.contains("why it mattered: w fix incomplete: still there\n"),
        "{p}"
    );
}
