//! The coordinator's dispositions (`lib/unit-seam.mjs`; realm @nick/craft, #315, #321): which
//! pooled findings an open cross-unit question named, what the coordinator did with each, and the
//! report's list of what it set aside — a finding never leaves a review silently.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::tool::title_key_of;

/// How many dependent findings the coordinator confirmed, dropped and turned into seam findings.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Counts {
    pub confirm: usize,
    pub drop: usize,
    pub convert: usize,
}

/// A finding the coordinator took out of the pool before verification, with its why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetAside {
    pub action: String,
    pub lens: String,
    pub title: String,
    pub file: String,
    pub line: i64,
    pub severity: String,
    pub why: String,
}

fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

/// One finding's identity for a disposition: the lens that raised it, its file and its title; empty
/// for no title.
#[must_use]
pub fn dependent_key(lens: &str, file: &str, title: &str) -> String {
    let t = title_key_of(title);
    if t.is_empty() {
        return String::new();
    }
    format!("{lens}|{}|{t}", file.trim().to_lowercase())
}

/// The key of the finding a question or disposition names.
fn named_key(q: &Value) -> String {
    dependent_key(
        text(q, "lens"),
        text(q, "findingFile"),
        text(q, "findingTitle"),
    )
}

/// The coordinator's dispositions applied to `pool`, for the findings an open question named
/// (`dependent`): `drop` and `convert` take the finding out (a converted one comes back as the seam
/// finding the coordinator reports), `confirm` keeps it; a disposition naming any other finding, or
/// an unknown action, is ignored.
#[must_use]
pub fn apply(
    pool: Vec<Value>,
    dispositions: &[Value],
    dependent: &[Value],
) -> (Vec<Value>, Counts, Vec<SetAside>) {
    let named: BTreeSet<String> = dependent
        .iter()
        .map(named_key)
        .filter(|k| !k.is_empty())
        .collect();
    let mut counts = Counts::default();
    let mut gone: BTreeMap<String, (String, String)> = BTreeMap::new();
    for d in dispositions {
        let (action, key) = (text(d, "action"), named_key(d));
        if !named.contains(&key) {
            continue;
        }
        match action {
            "confirm" => counts.confirm += 1,
            "drop" => counts.drop += 1,
            "convert" => counts.convert += 1,
            _ => continue,
        }
        if action != "confirm" {
            gone.insert(key, (action.to_owned(), text(d, "why").to_owned()));
        }
    }
    let mut set_aside = Vec::new();
    let kept = pool
        .into_iter()
        .filter(|f| {
            let key = dependent_key(text(f, "source"), text(f, "file"), text(f, "title"));
            let Some((action, why)) = gone.get(&key) else {
                return true;
            };
            set_aside.push(SetAside {
                action: action.clone(),
                lens: text(f, "source").to_owned(),
                title: text(f, "title").to_owned(),
                file: text(f, "file").to_owned(),
                line: f.get("line").and_then(Value::as_i64).unwrap_or(0),
                severity: text(f, "severity").to_owned(),
                why: why.clone(),
            });
            false
        })
        .collect();
    (kept, counts, set_aside)
}

/// The report's section for what the coordinator set aside (`seamSetAsideSection`), empty when
/// nothing was.
#[must_use]
pub fn section<'a>(set_aside: impl Iterator<Item = &'a SetAside>) -> String {
    let rows: Vec<String> = set_aside
        .map(|s| {
            let or = |v: &'a str, d: &'a str| if v.is_empty() { d } else { v };
            format!(
                "- {} · {} · `{}:{}` · {} · {} — {}",
                s.action,
                or(&s.severity, "?"),
                or(&s.file, "?"),
                s.line,
                s.lens,
                s.title,
                or(&s.why, "(no why given)")
            )
        })
        .collect();
    if rows.is_empty() {
        return String::new();
    }
    format!(
        "\n\n## Set aside by the seam pass (unitScope)\nThese candidates were taken out before verification: an open cross-unit question named each, and the seam pass answered it — `drop` (its premise is false) or `convert` (reported as a seam finding instead). Not verified; listed so none leaves the review silently.\n{}",
        rows.join("\n")
    )
}

#[cfg(test)]
mod tests;
