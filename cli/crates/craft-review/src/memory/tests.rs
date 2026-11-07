use serde_json::json;

use super::matching::{match_of, tried_order};
use super::record::{parse, plain_label};
use super::{Memory, PriorDecision};

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
    assert_eq!((m.at, m.how), (2, "matched by file:line+lens+toolRule"));
}

#[test]
fn the_launchers_records_apply_before_any_recall_and_the_memory_line_says_so() {
    let m = Memory::open(Some(
        json!([{"id": "decision-x", "title": "t", "reason": "r", "scope": "src"}, 7]),
    ));
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
