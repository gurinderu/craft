//! The Sift phase's memory part of one parity case, as `triage-findings.js` runs it: the
//! launcher's records, the recall over the kept findings' files (none when no finding names one),
//! then the decisions and the rules, each judge answered as the case scripts it.

use craft_review::memory::{Memory, PriorDecision, Scope};
use craft_store::js::Js;
use serde_json::Value;

use crate::field::At;
use crate::memory::{NOT_RECALLED, NOTE, Settled, as_values, recall_paths, settled};
use crate::sift::Sifted;

/// The recall's answer when a case scripts none: read, nothing recalled (the test's `MEMORY`).
const RECALLED_NOTHING: &str = r#"{"backend":"mcp iskron","why":"recalled","decisions":[]}"#;

/// A case's JSON as plain JSON, `None` when it is null.
fn plain(v: &Js) -> Option<Value> {
    (!matches!(v, Js::Null)).then(|| serde_json::from_str(&v.compact()).unwrap())
}

/// What the case's scope check saw: the ids it names unchanged, and those it names missing among
/// the records it was handed (`readScopeCheck`); a dead one, or one whose `unchanged` is no list,
/// nothing.
fn scope_seen(answer: Option<&Value>, ds: &[&PriorDecision]) -> Scope {
    let read = answer.filter(|a| a.get("unchanged").is_some_and(Value::is_array));
    let named = |k: &str, id: &str| {
        read.and_then(|a| a.get(k))
            .and_then(Value::as_array)
            .is_some_and(|l| l.iter().any(|x| x == id))
    };
    let mut s = Scope::default();
    for d in ds {
        if named("unchanged", &d.id) {
            s.unchanged.insert(d.id.clone());
        }
        if named("missing", &d.id) {
            s.missing.insert(d.id.clone());
        }
    }
    s
}

/// The memory as the case leaves it, and the batch `kept` sifted by it.
pub(super) fn sift(args: &Js, answers: &Js, base: &str, kept: &[Sifted]) -> (Memory, Settled) {
    let passed = plain(args.at("priorDecisions")).map(Ok);
    let mut memory = Memory::open(passed);
    let paths = recall_paths(kept);
    if paths.is_empty() {
        memory.not_recalled(NOT_RECALLED);
    } else {
        let (_, cut) = Memory::recall_ask(&paths, base).unwrap();
        let answer = plain(answers.at("memoryRecall"))
            .unwrap_or_else(|| serde_json::from_str(RECALLED_NOTHING).unwrap());
        memory.take_recalled(Some(&answer), cut, &paths);
    }
    let scope = plain(answers.at("scope"));
    let check = |ds: &[&PriorDecision]| scope_seen(scope.as_ref(), ds);
    let values = as_values(kept);
    memory.match_ask(&values, &[], &check).unwrap();
    let judged = plain(answers.at("match"));
    let mut decided = memory.decide(values, (judged.as_ref(), &[]), &check, NOTE);
    let asks = memory.rule_asks(&decided.kept, &[]).unwrap();
    let scripted = answers.at("rules").as_arr().unwrap_or_default();
    let ruled: Vec<Option<Value>> = (0..asks.len())
        .map(|i| scripted.get(i).and_then(plain))
        .collect();
    let kept_now = std::mem::take(&mut decided.kept);
    let ruled = memory.rule(kept_now, (&ruled, &[]), NOTE);
    (memory, settled(kept, decided, ruled))
}
