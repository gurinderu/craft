//! The project memory held to the engines' by `content/parity/memory-cases.json`, whose expected
//! side `lib/memory-parity.test.mjs` computes with `lib/memory-recall.mjs`,
//! `lib/prior-decision-apply.mjs` and `lib/project-rule-apply.mjs`: the same recall, launcher list,
//! findings, scope check and judges' answers give the same findings kept (with their marks) and set
//! aside, notes, source and report sections.

use serde_json::{Value, json};

use super::apply::{self, Scope};
use super::judge::{self, Judge};
use super::{Memory, PriorDecision, merge, recall, rules};

const CASES: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../content/parity/memory-cases.json"
));
/// The memory's prompts triage-findings renders too: the recall's and the judges', which
/// `lib/judge-prompt-parity.test.mjs` writes.
const PROMPTS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../content/parity/judge-prompt-cases.json"
));

#[test]
fn the_recall_prompt_renders_as_the_engines_render_it() {
    let file: Value = serde_json::from_str(PROMPTS).unwrap();
    let (input, want) = (&file["input"], &file["expected"]);
    let base = input["base"].as_str().unwrap();
    let paths: Vec<String> = serde_json::from_value(input["recallPaths"].clone()).unwrap();
    for (case, paths) in [("paths", paths), ("none", Vec::new())] {
        let got = recall::prompt(&paths, base).unwrap();
        assert_eq!(
            got,
            want["memoryRecall"][case].as_str().unwrap(),
            "recall: {case}"
        );
    }
}

#[test]
fn the_judges_prompts_render_as_the_engines_render_them() {
    let file: Value = serde_json::from_str(PROMPTS).unwrap();
    let (input, want) = (&file["input"], &file["expected"]);
    let side = |key: &str, record: &str| -> Vec<(PriorDecision, Value)> {
        input[key]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| {
                (
                    serde_json::from_value(p[record].clone()).unwrap(),
                    p["finding"].clone(),
                )
            })
            .collect()
    };
    for (judge, key, record, json) in [
        (Judge::Match, "judgePairs", "record", "matchJudge"),
        (Judge::Rule, "rulePairs", "rule", "ruleJudge"),
    ] {
        let pairs = side(key, record);
        let borrowed: Vec<(&PriorDecision, &Value)> = pairs.iter().map(|(d, f)| (d, f)).collect();
        let block = match judge {
            Judge::Match => judge::match_pairs_json(&borrowed),
            Judge::Rule => judge::rule_pairs_json(&borrowed),
        };
        let got = judge.task(&block).unwrap().prompt;
        assert_eq!(got, want[json].as_str().unwrap(), "{json}");
    }
}

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
        let prepared = apply::prepare(&findings, &m.decisions, &|ds| scope_seen(case, ds));
        let out = apply::apply(findings, &prepared, case.get("judge"));
        let pairs = rules::Pairs::new(&out.kept, &m.decisions);
        let ruled = rules::apply(out.kept, &pairs, case.get("ruleJudge"));
        let kept: Vec<Value> = ruled
            .kept
            .iter()
            .map(|f| {
                let mut k = pick(f, &["title", "why"]);
                if let Some(c) = f.get("memoryContradicts") {
                    k["memoryContradicts"] = c.clone();
                }
                k
            })
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
        let mut set_aside = out.set_aside;
        set_aside.extend(ruled.covered);
        let aside: Vec<Value> = set_aside.iter().map(|f| pick(f, &keys)).collect();
        assert_eq!(json!(aside), want["setAside"], "{name}: set aside");
        let mut notes = out.notes;
        notes.extend(ruled.notes);
        assert_eq!(json!(notes), want["notes"], "{name}: notes");
        assert_eq!(m.source.record(), want["memory"], "{name}: memory");
        let mut refused = m.refused;
        refused.extend(out.refused);
        let memory = Memory {
            passed: None,
            decisions: m.decisions,
            refused,
            source: m.source,
            set_aside,
            rule_notices: ruled.notices,
            ..Memory::default()
        };
        assert_eq!(
            memory.report(&[], &ruled.kept),
            want["report"].as_str().unwrap(),
            "{name}: report"
        );
    }
}
