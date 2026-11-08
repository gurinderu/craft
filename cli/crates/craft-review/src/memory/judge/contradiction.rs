//! A finding that shows the code going against a record the memory holds, as
//! `lib/memory-contradiction.mjs` marks and lists it (realm @nick/craft, nodes #282, #423): the
//! judges say so beside their own verdict, the finding stays in the verdict marked with the
//! record, and the report names it — a not-confirmed one with its tier, a doubt to check; the run
//! record counts them (`contradictionRecord`, node #281).

use serde_json::{Value, json};

use super::super::PriorDecision;
use super::{WHY_MAX, clip, line_of, plain};
use crate::gate::lines::Lines;
use crate::publish::doubt_reasons;

/// The record a finding's code goes against, as its mark carries it (`markContradicting`):
/// unchanged when there is none or it is marked already.
pub(in crate::memory) fn mark_contradicting(
    f: Value,
    against: Option<(&PriorDecision, &str)>,
) -> Value {
    let Some((d, why)) = against else {
        return f;
    };
    if contradiction_of(&f).is_some() {
        return f;
    }
    let mut f = f;
    if let Some(o) = f.as_object_mut() {
        o.insert(
            "memoryContradicts".into(),
            serde_json::json!({"id": d.id, "kind": d.kind, "why": clip(why, WHY_MAX)}),
        );
    }
    f
}

/// The record a finding is marked as going against: its id, kind and the judge's why
/// (`contradictionOf`).
pub(crate) fn contradiction_of(f: &Value) -> Option<(String, String, String)> {
    let m = f.get("memoryContradicts")?.as_object()?;
    let id = m.get("id")?.as_str().filter(|s| !s.is_empty())?;
    let text = |k: &str| plain(m.get(k));
    Some((id.to_owned(), text("kind"), text("why")))
}

/// The report section naming each finding going against memory, with the record, the judge's why
/// and a not-confirmed one's tier (`contradictionSection`); '' when there is none.
pub(in crate::memory) fn contradiction_section(findings: &[Value]) -> String {
    let lines: Vec<String> = findings
        .iter()
        .filter_map(|f| {
            let (id, kind, why) = contradiction_of(f)?;
            let tier = f
                .get("tier")
                .and_then(Value::as_str)
                .unwrap_or("confirmed")
                .to_lowercase();
            let tier = if tier == "confirmed" {
                String::new()
            } else {
                format!(" · not confirmed ({tier})")
            };
            let file = plain(f.get("file"));
            Some(format!(
                "- {} · `{}:{}` · {} · goes against {} {id}: {why}{tier}",
                f.get("severity").and_then(Value::as_str).unwrap_or("?"),
                if file.is_empty() { "?" } else { &file },
                line_of(f),
                plain(f.get("title")),
                if kind.is_empty() { "record" } else { &kind },
            ))
        })
        .collect();
    if lines.is_empty() {
        return String::new();
    }
    format!(
        "\n\n## Contradicts project memory — a defect when confirmed, whatever the other doubt signs say\n{}\n",
        lines.join("\n")
    )
}

/// The run record's count of the `findings` going against a memory record (`contradictionRecord`):
/// each with the record, the doubt signs that would have sent it to the reviewer without the mark
/// (`changed` `None`: the outside-the-diff sign untold, `inDiffJudged` false), whether `to_pr` sent
/// it to the PR as a defect, and the fields its fingerprint is taken over (`key`), which the
/// record's writer turns into `fp` as it does a ledger row's.
pub(crate) fn contradiction_record(
    findings: &[Value],
    changed: Option<&Lines>,
    to_pr: impl Fn(&Value) -> bool,
) -> Value {
    let items: Vec<Value> = findings
        .iter()
        .filter_map(|f| {
            let (id, kind, _) = contradiction_of(f)?;
            let text = |k: &str| plain(f.get(k));
            Some(json!({
                "key": {"file": text("file"), "symbol": text("symbol"), "ruleId": text("ruleId"), "title": text("title")},
                "record": id, "kind": kind, "severity": text("severity"), "title": clip(&text("title"), WHY_MAX),
                "file": text("file"), "line": line_of(f), "doubtSigns": doubt_reasons(f, changed), "toPr": to_pr(f),
            }))
        })
        .collect();
    let alone = items
        .iter()
        .filter(|i| i["doubtSigns"].as_array().is_some_and(|a| !a.is_empty()))
        .count();
    json!({"count": items.len(), "doubtSignsAlone": alone, "inDiffJudged": changed.is_some(), "findings": items})
}
