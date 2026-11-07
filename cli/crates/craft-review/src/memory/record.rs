//! One remembered record read and checked, as `lib/prior-decision-record.mjs` reads it (realm
//! @nick/craft, nodes #177, #204, #222, #230, #236, #273), and a list of them as
//! `parsePriorDecisions` in `lib/prior-decisions.mjs` reads it (node #218): a decision, a question
//! (a deferred finding) or a project rule, its fields as trimmed strings, refused by name when a
//! field is missing, past its ceiling, or unfit for the git line its scope check runs.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

mod check;
mod list;

use check::problem;
pub(super) use list::{Parsed, parse, plain_label};

use super::id::memory_record_id;

/// What a record is to a review.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecordKind {
    #[default]
    Decision,
    Question,
    Rule,
}

impl RecordKind {
    /// What a note calls a record of this kind, as `priorKindLabel`.
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::Question => "question",
            Self::Decision | Self::Rule => "decision",
        }
    }
}

/// One record as a review holds it. `line` 0 is no line; `stores` are the store's own ids its
/// `store: <id>` links name; `supersedes` the ids its `supersedes:` and `answers:` links name.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PriorDecision {
    pub id: String,
    pub title: String,
    pub scope: String,
    pub reason: String,
    pub who: String,
    pub when: String,
    pub link: String,
    pub commit: String,
    pub kind: RecordKind,
    pub deferred: bool,
    pub supersedes: Vec<String>,
    pub stores: Vec<String>,
    /// Its id was derived from its kind, title and scope, it having none.
    pub derived: bool,
    pub line: u64,
    pub lens: String,
    pub tool_rule: String,
    pub overrides: Vec<String>,
}

/// A string field trimmed, '' when it is no string (`decisionText`).
pub(super) fn text(v: Option<&Value>) -> String {
    v.and_then(Value::as_str)
        .map(|s| s.trim().to_owned())
        .unwrap_or_default()
}

/// A length as JavaScript counts it, in UTF-16 units, so a ceiling refuses what the engines do.
pub(super) fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Whether `s` holds a control character, a newline among them.
pub(super) fn has_control(s: &str) -> bool {
    s.chars().any(|c| u32::from(c) < 32 || u32::from(c) == 127)
}

/// A value as `JSON.stringify` prints it in a refusal.
fn json(v: Option<&Value>) -> String {
    v.map_or_else(|| "undefined".into(), Value::to_string)
}

/// Path segments with `.`, empty ones and separators folded; `..` kept literal.
pub(super) fn scope_parts(p: &str) -> Vec<&str> {
    p.split(['/', '\\'])
        .filter(|s| !s.is_empty() && *s != ".")
        .collect()
}

/// A record's `line`: a whole number below 10^9, or a string of up to nine digits; 0 when absent;
/// -1 when malformed.
fn record_line(v: Option<&Value>) -> i64 {
    match v {
        None | Some(Value::Null) => 0,
        Some(Value::String(s)) if s.is_empty() => 0,
        Some(Value::String(s)) => {
            let t = s.trim();
            let digits = (1..=9).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_digit());
            if digits { t.parse().unwrap_or(-1) } else { -1 }
        }
        Some(Value::Number(n)) => n
            .as_i64()
            .filter(|x| (0..1_000_000_000).contains(x))
            .unwrap_or(-1),
        Some(Value::Bool(_) | Value::Array(_) | Value::Object(_)) => -1,
    }
}

/// A record's kind, lower-cased; without one, the kind its id prefix names, else `decision`.
fn record_kind(o: &Map<String, Value>) -> String {
    if o.get("kind").is_some_and(|k| !k.is_null()) {
        return text(o.get("kind")).to_lowercase();
    }
    let id = text(o.get("id")).to_lowercase();
    ["decision", "question", "lesson", "rule"]
        .into_iter()
        .find(|k| id.starts_with(&format!("{k}-")))
        .unwrap_or("decision")
        .to_owned()
}

/// The memory skill's id of a record from its own kind, title and scope; '' when it lacks one.
pub(super) fn skill_record_id(o: &Map<String, Value>) -> String {
    let kind = text(o.get("kind")).to_lowercase();
    let (title, scope) = (text(o.get("title")), text(o.get("scope")));
    if kind.is_empty() || title.is_empty() || scope.is_empty() {
        return String::new();
    }
    memory_record_id(&kind, &title, &scope)
}

/// The id a record without one gets; '' when it has one or cannot get one.
fn derived_record_id(o: &Map<String, Value>) -> String {
    if text(o.get("id")).is_empty() {
        skill_record_id(o)
    } else {
        String::new()
    }
}

/// The record's id: its own, else the derived one, else ''.
pub(super) fn record_id(o: &Map<String, Value>) -> String {
    let own = text(o.get("id"));
    if own.is_empty() {
        derived_record_id(o)
    } else {
        own
    }
}

/// The ids the links of the form `<prefix>: <id>` name, for any of `prefixes`.
pub(super) fn linked_ids(links: &[Value], prefixes: &[&str]) -> Vec<String> {
    links
        .iter()
        .filter_map(|l| {
            let s = text(Some(l));
            let (head, rest) = s.split_once(':')?;
            let id = rest.trim_start();
            let named = prefixes.iter().any(|p| head.eq_ignore_ascii_case(p));
            (named && !id.is_empty() && !id.contains(char::is_whitespace)).then(|| id.to_owned())
        })
        .collect()
}

fn links(o: &Map<String, Value>) -> &[Value] {
    o.get("links")
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// A read kind as a review holds it: `question` and `rule` as they are, anything else a decision.
fn prior_kind(k: &str) -> RecordKind {
    match k {
        "question" => RecordKind::Question,
        "rule" => RecordKind::Rule,
        _ => RecordKind::Decision,
    }
}

/// The record's fields as a review reads them (`decisionFields`): `body`, `date` and `author`
/// stand in for `reason`, `when` and `who`, the first http(s) link for `link`.
fn fields(o: &Map<String, Value>) -> PriorDecision {
    let f = |k: &str, alt: &str| {
        let v = text(o.get(k));
        if v.is_empty() { text(o.get(alt)) } else { v }
    };
    let ls = links(o);
    let url = ls
        .iter()
        .map(|l| text(Some(l)))
        .find(|l| l.starts_with("http://") || l.starts_with("https://"))
        .unwrap_or_default();
    let derived = derived_record_id(o);
    let line = record_line(o.get("line"));
    let overrides = o.get("overrides").and_then(Value::as_array);
    PriorDecision {
        id: if f("id", "").is_empty() {
            derived.clone()
        } else {
            f("id", "")
        },
        title: f("title", ""),
        scope: Some(f("scope", ""))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| ".".into()),
        reason: f("reason", "body"),
        who: f("who", "author"),
        when: f("when", "date"),
        link: Some(f("link", "")).filter(|s| !s.is_empty()).unwrap_or(url),
        commit: f("commit", ""),
        kind: prior_kind(&record_kind(o)),
        deferred: o.get("deferred") == Some(&Value::Bool(true)),
        supersedes: linked_ids(ls, &["supersedes", "answers"]),
        stores: linked_ids(ls, &["store"]),
        derived: !derived.is_empty(),
        line: u64::try_from(line).unwrap_or(0),
        lens: text(o.get("lens")),
        tool_rule: text(o.get("toolRule")),
        overrides: overrides
            .into_iter()
            .flatten()
            .map(|v| text(Some(v)))
            .filter(|s| !s.is_empty())
            .collect(),
    }
}

/// One record as given, checked: the record, or the refusal naming it by `label`.
///
/// # Errors
/// The refusal sentence when the record is unfit.
pub(super) fn read(raw: &Value, label: &str) -> Result<PriorDecision, String> {
    let Some(o) = raw.as_object() else {
        return Err(format!("{label} is not an object"));
    };
    let d = fields(o);
    let why = problem(o, &d);
    if why.is_empty() {
        return Ok(d);
    }
    let id = if d.id.is_empty() || has_control(&d.id) {
        String::new()
    } else {
        format!(" ({})", d.id)
    };
    Err(format!("{label}{id}{why}"))
}
