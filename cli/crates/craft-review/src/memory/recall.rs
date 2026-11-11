//! The recall of the project's memory, as `lib/memory-recall.mjs` runs it (realm @nick/craft,
//! nodes #203, #204, #215, #250, #273): one read-only agent recalls, through the craft:memory skill,
//! the active decisions, questions and project rules for the diff's paths; its answer is read here,
//! each record given the skill's id where the store keeps its own, and the source it came from is
//! named in one line of the report.

use super::{MemorySource, oppose};
use serde_json::{Map, Value};

use super::record::{skill_record_id, text};
use crate::content::{self, ContentError, vars};

/// The most changed paths one recall prompt lists; the rest are counted.
pub(super) const RECALL_PATHS_MAX: usize = 60;
/// The recall agent's prompt for the changed `paths` (`memoryRecallPrompt`).
///
/// # Errors
/// When the template is missing.
pub(super) fn prompt(paths: &[String], base: &str) -> Result<String, ContentError> {
    let listed: Vec<&String> = paths.iter().take(RECALL_PATHS_MAX).collect();
    let cut = paths.len() - listed.len();
    let scope = if listed.is_empty() {
        let base = if base.is_empty() {
            "$(git merge-base origin/main HEAD)"
        } else {
            base
        };
        format!("the paths of `git diff --name-only {base}...HEAD`")
    } else {
        let lines: Vec<String> = listed.iter().map(|p| format!("- {p}")).collect();
        let tail = if cut > 0 {
            format!(
                "\n({cut} more path(s) cut at the bound of {RECALL_PATHS_MAX} — not recalled for)"
            )
        } else {
            String::new()
        };
        format!(
            "these changed paths of the diff:\n{}{tail}",
            lines.join("\n")
        )
    };
    content::prompt("memory-recall", &vars([("scope", scope)]))
}

/// What the recall returned: its records, each id set as the skill sets it, and the source.
#[derive(Debug, Clone, Default)]
pub(super) struct Recalled {
    pub records: Vec<Value>,
    pub source: MemorySource,
    /// The records the store withdrew or superseded, named only: they hold back a passed copy.
    pub inactive: Vec<oppose::Inactive>,
}

/// One line of an answer's text, its whitespace collapsed (`recallText`).
pub(super) fn one_line(v: Option<&Value>) -> String {
    v.and_then(Value::as_str)
        .map(|s| s.split_whitespace().collect::<Vec<_>>().join(" "))
        .unwrap_or_default()
}

/// The records of a recalled list, each tagged with `kind` when it carries none.
fn of_kind(list: Option<&Value>, kind: &str) -> Vec<Value> {
    let tag = |v: &Value| {
        let mut v = v.clone();
        if let Some(o) = v.as_object_mut().filter(|o| !o.contains_key("kind")) {
            o.insert("kind".into(), Value::from(kind));
        }
        v
    };
    list.and_then(Value::as_array)
        .map(|l| l.iter().map(tag).collect())
        .unwrap_or_default()
}

/// Whether `id` has the memory skill's form, `<kind>-` and 10 hex characters.
fn skill_form(id: &str) -> bool {
    id.split_once('-').is_some_and(|(k, h)| {
        ["decision", "question", "lesson", "rule", "external"].contains(&k)
            && h.len() == 10
            && h.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

/// A recalled record with the skill's id where the store keeps its own (`withSkillId`, node
/// #215): the store's id kept in its links as `store: <id>`.
fn with_skill_id(x: Value) -> Value {
    let Value::Object(mut o) = x else {
        return x;
    };
    let links: Vec<Value> = o
        .get("links")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let stored = links.iter().any(|l| {
        let s = text(Some(l));
        s.get(..6).is_some_and(|h| h.eq_ignore_ascii_case("store:"))
            && s.get(6..).is_some_and(|r| !r.trim_start().is_empty())
    });
    let (id, sid) = (text(o.get("id")), skill_record_id(&o));
    if id.is_empty() || sid.is_empty() || sid == id || (!stored && skill_form(&id)) {
        return Value::Object(o);
    }
    let mut links = links;
    if !stored {
        links.push(Value::from(format!("store: {id}")));
    }
    o.insert("id".into(), Value::from(sid));
    o.insert("links".into(), Value::Array(links));
    Value::Object(o)
}

/// The stale decisions the agent left out, as one line's tail.
fn stale_tail(list: Option<&Value>) -> String {
    let named: Vec<String> = list
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|x| {
            let id = one_line(x.get("id"));
            let why = Some(one_line(x.get("why"))).filter(|w| !w.is_empty());
            (!id.is_empty())
                .then(|| format!("{id} ({})", why.as_deref().unwrap_or("no reason given")))
        })
        .collect();
    if named.is_empty() {
        String::new()
    } else {
        format!("; stale, left out: {}", named.join(", "))
    }
}

/// The recall agent's answer read (`readMemoryRecall`); `cut` the paths past the prompt's bound. A
/// dead or off-shape answer applies nothing and says so.
pub(super) fn read(raw: Option<&Value>, cut: usize) -> Recalled {
    let empty = Map::new();
    let r = raw.and_then(Value::as_object).unwrap_or(&empty);
    let tail = if cut > 0 {
        format!(
            "; {cut} changed path(s) past the bound of {RECALL_PATHS_MAX} were not recalled for"
        )
    } else {
        String::new()
    };
    let inactive = oppose::inactive(r.get("inactive"));
    let Some(list) = r.get("decisions").and_then(Value::as_array) else {
        return Recalled {
            inactive,
            records: Vec::new(),
            source: MemorySource::none(format!(
                "the recall agent died or returned no decision list, so nothing recalled was applied — findings are raised normally{tail}"
            )),
        };
    };
    let backend = Some(one_line(r.get("backend")))
        .filter(|b| !b.is_empty())
        .unwrap_or_else(|| "an unnamed backend".into());
    let why = Some(one_line(r.get("why")))
        .filter(|w| !w.is_empty())
        .unwrap_or_else(|| "no reason given".into());
    let stale = stale_tail(r.get("stale"));
    let questions = of_kind(r.get("questions"), "question");
    let rules = of_kind(r.get("rules"), "rule");
    let externals = of_kind(r.get("externals"), "external").len();
    let (nq, nr) = (questions.len(), rules.len());
    let records: Vec<Value> = list
        .iter()
        .cloned()
        .chain(questions)
        .chain(rules)
        .map(with_skill_id)
        .collect();
    if records.is_empty() && externals == 0 {
        let mut source = MemorySource::none(format!("{why} (backend {backend}){stale}{tail}"));
        source.backend = Some(backend);
        return Recalled {
            records,
            source,
            inactive,
        };
    }
    let mut source =
        MemorySource::none(format!("{backend} ({why}){stale}{tail}")).with_kinds(nq, nr, externals);
    source.source = "recalled".into();
    source.count = records.len();
    source.backend = Some(backend);
    Recalled {
        records,
        source,
        inactive,
    }
}
