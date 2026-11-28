//! What the runs recalled before judging, read off each record's `memory` (realm @nick/craft,
//! nodes #40, #273, #431): from which backend, how many records, questions, rules and external
//! systems, the findings a project rule covered, and why a recall found none. A run nested under
//! an audit (`source: launcher`) applies the audit's one recall and is counted apart; a recall that
//! may not have read the store is degraded — not read, partly read, or a launcher's degraded
//! recall handed down — never "no memory". A run without the field is not measured.

use std::collections::BTreeMap;

use crate::js::{Js, Obj, Utf16Error};

/// The memory sums over the runs.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Memory {
    pub runs: u64,
    pub carrying: u64,
    pub recalled: u64,
    pub passed_only: u64,
    pub nested: u64,
    pub none: u64,
    pub records: f64,
    pub questions: f64,
    pub rules: f64,
    pub externals: f64,
    pub covered: f64,
    pub not_read: u64,
    pub partly_read: u64,
    pub launcher_degraded: u64,
    pub by_backend: BTreeMap<String, u64>,
    pub none_why: BTreeMap<String, u64>,
}

/// A positive finite count, else 0.
fn count(o: &Obj, k: &str) -> f64 {
    o.get(k)
        .and_then(Js::as_num)
        .filter(|n| n.is_finite() && *n > 0.0)
        .unwrap_or(0.0)
}

/// A non-empty string, else `fallback`.
fn text(o: &Obj, k: &str, fallback: &str) -> Result<String, Utf16Error> {
    match o.get(k) {
        Some(Js::Str(s)) if !s.is_empty() => s.to_utf8(),
        _ => Ok(fallback.to_owned()),
    }
}

/// The engines' own reasons for a none, by their opening words, and the class each names.
const NONE_CLASSES: [(&str, &str); 4] = [
    (
        "the recall agent died",
        "the recall agent died or returned no list",
    ),
    (
        "the recall agent did not run",
        "the recall agent did not run",
    ),
    (
        "recall did not run — budget below the floor",
        "budget below the floor",
    ),
    ("pinned backend unavailable", "pinned backend unavailable"),
];

/// The class of a none's reason: its free prose ranked whole would give every run its own row.
fn none_class(why: &str, backend: &str, query_error: bool) -> String {
    if why.starts_with("not recalled — ") {
        return why.split(';').next().unwrap_or(why).to_owned();
    }
    if let Some((_, class)) = NONE_CLASSES.iter().find(|(lead, _)| why.starts_with(lead)) {
        return (*class).to_owned();
    }
    if query_error {
        format!("backend query may have failed in {backend}")
    } else {
        format!("recall found nothing in {backend}")
    }
}

impl Memory {
    /// Adds one run.
    /// # Errors
    /// When a backend or a reason cannot be represented as Unicode.
    pub fn add(&mut self, r: &Obj) -> Result<(), Utf16Error> {
        self.runs += 1;
        let Some(o) = r.get("memory").and_then(Js::as_obj) else {
            return Ok(());
        };
        self.carrying += 1;
        self.covered += count(o, "covered");
        let source = o.text_units("source");
        let has = |k: &str| matches!(o.get(k), Some(Js::Str(s)) if !s.is_empty());
        let recalled = source == "recalled";
        if has("recallDegraded") {
            self.launcher_degraded += 1;
        } else if recalled && (has("queryError") || has("truncated")) {
            self.partly_read += 1;
        } else if !recalled && (has("queryError") || has("recallDied") || has("truncated")) {
            self.not_read += 1;
        }
        if source == "launcher" {
            self.nested += 1;
            return Ok(());
        }
        if recalled {
            self.recalled += 1;
            self.records += count(o, "count");
            self.questions += count(o, "questions");
            self.rules += count(o, "rules");
            self.externals += count(o, "externals");
            *self
                .by_backend
                .entry(text(o, "backend", "unnamed")?)
                .or_default() += 1;
            return Ok(());
        }
        self.none += 1;
        self.passed_only += u64::from(count(o, "passed") > 0.0);
        let class = none_class(
            &text(o, "why", "no reason recorded")?,
            &text(o, "backend", "an unnamed backend")?,
            has("queryError"),
        );
        *self.none_why.entry(class).or_default() += 1;
        Ok(())
    }
}

#[cfg(test)]
mod tests;
