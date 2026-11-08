//! The pairs a judge reads, as `judgePair` and `rulePair` build them and `JSON.stringify` writes
//! them: each field in the engine's order, so the prompt is the engine's to the byte.

use serde_json::Value;

use super::super::PriorDecision;
use super::{WHY_MAX, body_of, clip, clip_field, lenses_text, line_of};

/// A JSON string, escaped as `JSON.stringify` escapes it.
fn s(text: &str) -> String {
    Value::String(text.to_owned()).to_string()
}

/// An object of `fields`, each already written, in the order given.
fn object(fields: &[(&str, String)]) -> String {
    let inner: Vec<String> = fields
        .iter()
        .map(|(k, v)| format!("{}:{v}", s(k)))
        .collect();
    format!("{{{}}}", inner.join(","))
}

/// The finding's side of a match pair.
fn match_finding(f: &Value) -> String {
    object(&[
        ("title", s(&clip_field(f, "title"))),
        ("file", s(&clip_field(f, "file"))),
        ("line", line_of(f).to_string()),
        ("lens", s(&clip(&lenses_text(f), WHY_MAX))),
        ("toolRule", s(&clip_field(f, "toolRule"))),
        ("body", s(&body_of(f))),
    ])
}

/// One record–finding pair of the match judge, numbered `i` (`judgePair`): the record's reason left
/// out, every field quoted data.
fn match_pair(i: usize, d: &PriorDecision, f: &Value) -> String {
    let record = object(&[
        ("kind", s(d.kind.name())),
        ("id", s(&d.id)),
        ("title", s(&clip(&d.title, WHY_MAX))),
        ("file", s(&d.scope)),
        ("line", d.line.to_string()),
        ("lens", s(&clip(&d.lens, WHY_MAX))),
        ("toolRule", s(&clip(&d.tool_rule, WHY_MAX))),
    ]);
    object(&[
        ("pair", i.to_string()),
        ("record", record),
        ("finding", match_finding(f)),
    ])
}

/// One rule–finding pair of the rule judge, numbered `i` (`rulePair`): the rule's body left out.
fn rule_pair(i: usize, r: &PriorDecision, f: &Value) -> String {
    let rule = object(&[
        ("id", s(&r.id)),
        ("rule", s(&clip(&r.title, WHY_MAX))),
        ("scope", s(&r.scope)),
        ("lens", s(&clip(&r.lens, WHY_MAX))),
    ]);
    let finding = object(&[
        ("severity", s(&clip_field(f, "severity"))),
        ("title", s(&clip_field(f, "title"))),
        ("file", s(&clip_field(f, "file"))),
        ("line", line_of(f).to_string()),
        ("lens", s(&clip(&lenses_text(f), WHY_MAX))),
        ("body", s(&body_of(f))),
    ]);
    object(&[
        ("pair", i.to_string()),
        ("rule", rule),
        ("finding", finding),
    ])
}

/// The match judge's pairs as one JSON list.
pub(in crate::memory) fn match_pairs_json(pairs: &[(&PriorDecision, &Value)]) -> String {
    let items: Vec<String> = pairs
        .iter()
        .enumerate()
        .map(|(i, (d, f))| match_pair(i, d, f))
        .collect();
    format!("[{}]", items.join(","))
}

/// The rule judge's pairs as one JSON list.
pub(in crate::memory) fn rule_pairs_json(pairs: &[(&PriorDecision, &Value)]) -> String {
    let items: Vec<String> = pairs
        .iter()
        .enumerate()
        .map(|(i, (r, f))| rule_pair(i, r, f))
        .collect();
    format!("[{}]", items.join(","))
}
