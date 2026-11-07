//! The project memory held to the engines' by `content/parity/memory-cases.json`, whose expected
//! side `lib/memory-parity.test.mjs` computes with `lib/memory-recall.mjs` and
//! `lib/prior-decision-apply.mjs`: the same recall, launcher list, findings and scope check give
//! the same findings kept and set aside, notes, source and report sections.

use serde_json::{Value, json};

use super::apply::{self, Scope};
use super::{Memory, PriorDecision, merge, recall};

const CASES: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../content/parity/memory-cases.json"
));

/// What the case's scope check sees: the records whose commit it names unchanged or missing.
fn scope_seen(case: &Value, ds: &[&PriorDecision]) -> Scope {
    let named = |k: &str, commit: &str| case[k].as_array().unwrap().iter().any(|c| c == commit);
    let mut s = Scope::default();
    for d in ds {
        if named("unchanged", &d.commit) {
            s.unchanged.insert(d.id.clone());
        }
        if named("missing", &d.commit) {
            s.missing.insert(d.id.clone());
        }
    }
    s
}

fn pick(f: &Value, keys: &[&str]) -> Value {
    Value::Object(
        keys.iter()
            .map(|k| ((*k).to_owned(), f[*k].clone()))
            .collect(),
    )
}

#[test]
fn every_case_applies_as_the_engines_apply_it() {
    let file: Value = serde_json::from_str(CASES).unwrap();
    let cases = file["cases"].as_array().unwrap();
    assert!(cases.len() >= 5);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let want = &case["expected"];
        let recalled = recall::read(Some(&case["recall"]).filter(|r| !r.is_null()), 0);
        let m = merge::merge(recalled, case.get("passed"));
        let findings = case["findings"].as_array().unwrap().clone();
        let out = apply::apply(findings, &m.decisions, &|ds| scope_seen(case, ds));
        let kept: Vec<Value> = out
            .kept
            .iter()
            .map(|f| pick(f, &["title", "why"]))
            .collect();
        assert_eq!(json!(kept), want["kept"], "{name}: kept");
        let keys = [
            "title",
            "why",
            "priorTier",
            "priorDecision",
            "priorKind",
            "priorMatch",
        ];
        let aside: Vec<Value> = out.set_aside.iter().map(|f| pick(f, &keys)).collect();
        assert_eq!(json!(aside), want["setAside"], "{name}: set aside");
        assert_eq!(json!(out.notes), want["notes"], "{name}: notes");
        assert_eq!(m.source.record(), want["memory"], "{name}: memory");
        let mut refused = m.refused;
        refused.extend(out.refused);
        let memory = Memory {
            passed: None,
            decisions: m.decisions,
            refused,
            source: m.source,
            set_aside: out.set_aside,
            unread: None,
        };
        assert_eq!(
            memory.report(&[]),
            want["report"].as_str().unwrap(),
            "{name}: report"
        );
    }
}
