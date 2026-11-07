//! What refuses a record (`decisionProblem` in `lib/prior-decision-record.mjs`): a kind a review
//! does not apply, a status other than active, a missing field, a field past its ceiling, or an
//! anchor unfit for the git line its scope check runs.

use serde_json::{Map, Value};

use super::{
    PriorDecision, RecordKind, has_control, js_len, json, record_kind, record_line, scope_parts,
    text,
};

/// Each field's ceiling, in the order a refusal names the first one over it.
const FIELD_MAX: [(&str, usize); 7] = [
    ("id", 80),
    ("title", 200),
    ("scope", 300),
    ("reason", 1200),
    ("who", 120),
    ("when", 40),
    ("link", 500),
];

const LENS_MAX: usize = 80;

const TOOL_RULE_MAX: usize = 120;

const KINDS: [&str; 3] = ["decision", "question", "rule"];

/// What is wrong with a text field of the anchor; '' when it is absent or fit.
fn anchor_text_problem(o: &Map<String, Value>, k: &str, max: usize) -> String {
    match o.get(k) {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) if js_len(s.trim()) > max => {
            format!(
                ": {k} is {} chars, over the {max}-char ceiling",
                js_len(s.trim())
            )
        }
        Some(Value::String(s)) if has_control(s) => format!(": {k} contains a control character"),
        Some(Value::String(_)) => String::new(),
        v @ Some(_) => format!(": {k} {} is not a string", json(v)),
    }
}

/// What is wrong with a record's anchor (`line`, `lens`, `toolRule`); '' when nothing is.
fn anchor_field_problem(o: &Map<String, Value>) -> String {
    if record_line(o.get("line")) < 0 {
        return format!(": line {} is not a line number", json(o.get("line")));
    }
    let lens = anchor_text_problem(o, "lens", LENS_MAX);
    if lens.is_empty() {
        anchor_text_problem(o, "toolRule", TOOL_RULE_MAX)
    } else {
        lens
    }
}

/// The required fields missing, as the tail of a refusal; '' when none is.
fn missing_problem(d: &PriorDecision) -> String {
    if d.id.is_empty() && !d.title.is_empty() && !d.reason.is_empty() {
        return " lacks an id, and the kind or the scope its id is derived from".into();
    }
    let missing: Vec<&str> = [
        (d.id.is_empty(), "an id"),
        (d.title.is_empty(), "a title"),
        (d.reason.is_empty(), "a reason"),
    ]
    .into_iter()
    .filter_map(|(m, w)| m.then_some(w))
    .collect();
    match missing.split_last() {
        None => String::new(),
        Some((last, [])) => format!(" lacks {last}"),
        Some((last, rest)) => format!(" lacks {} and {last}", rest.join(", ")),
    }
}

/// A field of `d` by the name its ceiling has.
fn field<'a>(d: &'a PriorDecision, k: &str) -> &'a str {
    match k {
        "id" => &d.id,
        "title" => &d.title,
        "scope" => &d.scope,
        "reason" => &d.reason,
        "who" => &d.who,
        "when" => &d.when,
        _ => &d.link,
    }
}

/// The id, scope and commit go into a git line: no control character, the scope a repo-relative
/// path of safe characters, the commit a hash. '' when all hold.
fn anchor_problem(d: &PriorDecision) -> String {
    if let Some(k) = [("id", &d.id), ("scope", &d.scope), ("commit", &d.commit)]
        .into_iter()
        .find_map(|(k, v)| has_control(v).then_some(k))
    {
        return format!(": {k} contains a control character");
    }
    let s = &d.scope;
    let drive = s.as_bytes().get(1) == Some(&b':')
        && s.bytes().next().is_some_and(|b| b.is_ascii_alphabetic());
    if s.starts_with(['/', '\\', '~']) || drive || scope_parts(s).contains(&"..") {
        return format!(
            ": scope {} is not a repo-relative path",
            Value::from(s.as_str())
        );
    }
    let safe = |c: char| c.is_ascii_alphanumeric() || "._@+/ -".contains(c);
    if !s.chars().all(safe) {
        return format!(
            ": scope {} has a character outside letters, digits and ._@+/ -",
            Value::from(s.as_str())
        );
    }
    let hash =
        (7..=40).contains(&d.commit.len()) && d.commit.bytes().all(|b| b.is_ascii_hexdigit());
    if !d.commit.is_empty() && !hash {
        return format!(
            ": commit {} is not a commit hash",
            Value::from(d.commit.as_str())
        );
    }
    String::new()
}

/// What is wrong with a record, as the tail of a refusal; '' when nothing is.
pub(super) fn problem(o: &Map<String, Value>, d: &PriorDecision) -> String {
    let kind = record_kind(o);
    if !KINDS.contains(&kind.as_str()) {
        return format!(
            " is a {} record, not a decision, a question or a rule",
            Value::from(kind)
        );
    }
    if o.get("status").is_some_and(|s| !s.is_null()) && text(o.get("status")) != "active" {
        return format!(" is not active (status {})", json(o.get("status")));
    }
    if d.kind == RecordKind::Rule && text(o.get("scope")).is_empty() {
        return " is a project rule without a scope — a rule names the folder, component or `.` it covers".into();
    }
    let missing = missing_problem(d);
    if !missing.is_empty() {
        return missing;
    }
    if let Some((k, max)) = FIELD_MAX.iter().find(|(k, max)| js_len(field(d, k)) > *max) {
        return format!(
            ": {k} is {} chars, over the {max}-char ceiling",
            js_len(field(d, k))
        );
    }
    let anchor = anchor_field_problem(o);
    if anchor.is_empty() {
        anchor_problem(d)
    } else {
        anchor
    }
}
