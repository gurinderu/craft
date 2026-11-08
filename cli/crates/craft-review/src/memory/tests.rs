use serde_json::json;

use super::matching::{Match, plan, resolve, tried_order};
use super::record::{parse, plain_label};
use super::{MatchAsked, Memory, PriorDecision, RecordKind};
use crate::rereview::Chain;

/// A repository git cannot read: a scope check there finds every commit missing.
const NO_REPO: &str = "/nonexistent/craft-memory-test";

/// A confirmed clippy finding at `src/lib.rs:11` a record of the same rule answers outright.
fn tool_finding() -> serde_json::Value {
    json!({"severity": "Medium", "title": "needless clone", "file": "src/lib.rs", "line": 11, "source": "clippy", "toolRule": "clippy::redundant_clone", "tier": "confirmed", "why": "w"})
}

#[test]
fn the_match_judges_answer_is_read_against_the_scopes_kept_when_it_was_asked() {
    let d = PriorDecision {
        commit: "0123456789abcdef".into(),
        tool_rule: "redundant_clone".into(),
        ..decision("decision-a", "needless clone")
    };
    let repo = std::path::Path::new(NO_REPO);
    let mut chain = Chain::default();
    let mut m = Memory {
        decisions: vec![d],
        ..Memory::default()
    };
    let settled = vec![tool_finding()];
    // Handing the task out keeps what git saw: the commit is missing, so the match is raised
    // again and the judge is asked whether the code goes against it.
    let task = m.match_task(repo, &settled, &chain).unwrap();
    assert!(task.is_some());
    let kept = m.asked.matched.clone().unwrap();
    assert_eq!(
        (kept.missing.len(), kept.pairs.as_slice()),
        (1, [(0, 0)].as_slice())
    );
    // The answer is read against what was kept, not against a scope check run again: kept as
    // unchanged, the finding is set aside although git here would find the commit missing.
    m.asked.matched = Some(MatchAsked {
        unchanged: ["decision-a".to_owned()].into(),
        missing: std::collections::BTreeSet::new(),
        pairs: kept.pairs,
    });
    let (mut aside, mut notes) = (settled.clone(), Vec::new());
    m.apply(repo, &mut aside, &mut chain, &mut notes, None);
    assert_eq!((m.set_aside.len(), aside.len()), (1, 0), "{notes:?}");
    assert!(m.asked.matched.is_none(), "read once");
    // With nothing kept, git is asked, and the missing commit raises it again.
    let (mut again, mut notes) = (settled, Vec::new());
    let mut fresh = Memory {
        decisions: m.decisions.clone(),
        ..Memory::default()
    };
    fresh.apply(repo, &mut again, &mut chain, &mut notes, None);
    assert_eq!((fresh.set_aside.len(), again.len()), (0, 1));
}

#[test]
fn the_rule_judges_answer_is_read_against_the_pairs_kept_when_it_was_asked() {
    let rule = |id: &str| PriorDecision {
        kind: RecordKind::Rule,
        scope: "src".into(),
        lens: String::new(),
        ..decision(id, "clones are fine here")
    };
    let mut chain = Chain::default();
    let mut m = Memory {
        decisions: vec![rule("rule-a"), rule("rule-b")],
        ..Memory::default()
    };
    let settled = vec![tool_finding()];
    assert!(m.rule_task(&settled, &chain).unwrap().is_some());
    assert_eq!(m.asked.ruled.as_deref(), Some([(0, 0), (0, 1)].as_slice()));
    // Asked about the second rule only, its verdict on pair 0 is that rule's.
    m.asked.ruled = Some(vec![(0, 1)]);
    let answer = json!({"verdicts": [{"pair": 0, "covered": true, "violates": false, "why": "y"}]});
    let (mut kept, mut notes) = (settled, Vec::new());
    m.cover(&mut kept, &mut chain, &mut notes, Some(&answer));
    assert!(kept.is_empty() && m.asked.ruled.is_none());
    let aside = m.set_aside[0].to_string();
    assert!(
        aside.contains("rule-b") && !aside.contains("rule-a"),
        "{aside}"
    );
}

/// The record answering `f` with no judge to ask.
fn match_of(f: &serde_json::Value, ds: &[PriorDecision], order: &[usize]) -> Option<Match> {
    resolve(f, ds, &plan(f, ds, order), None)
}

fn decision(id: &str, title: &str) -> PriorDecision {
    PriorDecision {
        id: id.into(),
        title: title.into(),
        scope: "src/lib.rs".into(),
        reason: "r".into(),
        line: 10,
        lens: "clippy".into(),
        ..PriorDecision::default()
    }
}

#[test]
fn a_tool_finding_matches_only_a_record_of_its_own_rule_and_an_override_is_tried_first() {
    let f = json!({"file": "src/lib.rs", "line": 11, "title": "needless clone", "source": "clippy", "toolRule": "clippy::redundant_clone"});
    let other = PriorDecision {
        tool_rule: "needless_borrow".into(),
        ..decision("decision-a", "needless clone")
    };
    let ds = [other.clone()];
    assert_eq!(
        match_of(&f, &ds, &tried_order(&ds)),
        None,
        "another rule is another finding"
    );
    let same = PriorDecision {
        tool_rule: "redundant_clone".into(),
        ..decision("decision-b", "a clone")
    };
    let newer = PriorDecision {
        overrides: vec!["decision-b".into()],
        ..same.clone()
    };
    let ds = [
        other,
        same,
        PriorDecision {
            id: "decision-c".into(),
            ..newer
        },
    ];
    let order = tried_order(&ds);
    assert_eq!(order, [2, 0, 1]);
    let m = match_of(&f, &ds, &order).unwrap();
    assert_eq!(
        (m.at, m.how.as_str()),
        (2, "matched by file:line+lens+toolRule")
    );
}

#[test]
fn the_launchers_records_apply_before_any_recall_and_the_memory_line_says_so() {
    let m = Memory::open(Some(Ok(
        json!([{"id": "decision-x", "title": "t", "reason": "r", "scope": "src"}, 7]),
    )));
    assert_eq!(m.decisions.len(), 1);
    assert_eq!(m.refused, ["decision #1 is not an object"]);
    assert_eq!(
        m.source.line(),
        "memory: none — not recalled — the run ended before its recall step; plus 1 passed by the launcher"
    );
    assert!(Memory::open(None).decisions.is_empty());
}

#[test]
fn a_list_past_the_cap_names_what_it_did_not_apply() {
    let list: Vec<_> = (0..102)
        .map(
            |i| json!({"id": format!("decision-{i}"), "title": "t", "reason": "r", "scope": "src"}),
        )
        .collect();
    let p = parse(Some(&json!(list)), &plain_label);
    assert_eq!(p.decisions.len(), 100);
    assert_eq!(
        p.refused,
        [
            "2 decision(s) past the cap of 100 were not applied — findings they would answer are raised normally: decision #100 (decision-100), decision #101 (decision-101)"
        ]
    );
}
