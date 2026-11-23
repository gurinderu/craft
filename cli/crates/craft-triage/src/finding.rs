//! A gathered finding, as `triage-findings.js` reads one: the source it came from, its stable id,
//! and the file and line its location names.

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::TriageError;

/// The engines a report's source may name; anything else reads as `report`.
pub const REPORT_SOURCES: [&str; 5] = [
    "review",
    "adversarial-review",
    "rust-audit",
    "rust-reviewer",
    "nix-review",
];

/// The severities, Critical first.
pub const SEVERITIES: [&str; 5] = ["Critical", "High", "Medium", "Low", "Info"];

/// One finding a gatherer returned, with the source it came from.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Finding {
    pub severity: String,
    pub title: String,
    pub location: String,
    pub detail: String,
    pub proposed_fix: String,
    pub thread_id: String,
    pub source: String,
}

/// One gatherer's answer: its source and findings.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct Gathered {
    pub source: String,
    pub findings: Vec<Finding>,
}

impl Gathered {
    /// A gatherer's answer read; a report gatherer's source normalised by [`report_source`].
    ///
    /// # Errors
    /// [`TriageError::Answer`] when it is not the raw schema's shape.
    pub fn read(answer: &Value, from_report: bool) -> Result<Self, TriageError> {
        let mut g: Self = serde_json::from_value(answer.clone())
            .map_err(|e| TriageError::answer("a gatherer's answer", &e))?;
        if from_report {
            g.source = report_source(Some(&g.source));
        }
        Ok(g)
    }

    /// Its findings, each carrying the source.
    #[must_use]
    pub fn sourced(&self) -> Vec<Finding> {
        let source = &self.source;
        self.findings
            .iter()
            .map(|f| Finding {
                source: source.clone(),
                ..f.clone()
            })
            .collect()
    }
}

/// A report's source: the engine that wrote it as the gatherer read it, else `report`.
#[must_use]
pub fn report_source(said: Option<&str>) -> String {
    let said = said.map(str::trim).unwrap_or_default();
    if REPORT_SOURCES.contains(&said) {
        said.to_owned()
    } else {
        "report".to_owned()
    }
}

/// The stable composite id: `source::location::title`, `no-loc` for an empty location.
#[must_use]
pub fn id_of(f: &Finding) -> String {
    let location = if f.location.is_empty() {
        "no-loc"
    } else {
        &f.location
    };
    format!("{}::{location}::{}", f.source, f.title)
}

static AT_LINE: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"^(\S+?):(\d+)(?:[-:]\d+)?$").ok());
static A_PATH: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"^\S+[./]\S*$").ok());

/// The file and line a location names: `path:line` (a `:col` or `-end` after it ignored); a bare
/// path keeps line 0; a PR-level or empty location names no file.
#[must_use]
pub fn location_parts(location: &str) -> (String, u64) {
    let s = location.trim();
    if let Some(m) = AT_LINE.as_ref().and_then(|r| r.captures(s)) {
        let file = m.get(1).map_or("", |x| x.as_str());
        let line = m
            .get(2)
            .map_or(0, |x| x.as_str().parse().unwrap_or(u64::MAX));
        return (file.to_owned(), line);
    }
    let is_path = A_PATH.as_ref().is_some_and(|r| r.is_match(s));
    (if is_path { s.to_owned() } else { String::new() }, 0)
}

/// A severity's rank, Critical first, compared without case; an unknown one last.
#[must_use]
pub fn severity_rank(s: &str) -> usize {
    let s = s.trim().to_lowercase();
    SEVERITIES
        .iter()
        .position(|x| x.to_lowercase() == s)
        .unwrap_or(SEVERITIES.len())
}

#[cfg(test)]
mod tests;
