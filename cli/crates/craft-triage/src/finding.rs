//! A gathered finding, as `triage-findings.js` reads one: the source it came from, its stable id,
//! and the file and line its location names.

use crate::TriageError;
use crate::js;
use crate::json::{Json, Obj};

mod location;

pub use location::location_parts;

/// The engines a report's source may name; anything else reads as `report`.
pub const REPORT_SOURCES: [&str; 5] = [
    "review",
    "adversarial-review",
    "rust-audit",
    "rust-reviewer",
    "nix-review",
];

/// The fields `content/schemas/triage-raw.schema.json` requires of a finding, all text.
pub const FIELDS: [&str; 6] = [
    "severity",
    "title",
    "location",
    "detail",
    "proposed_fix",
    "thread_id",
];

/// The severities, Critical first (`craft_store::record::SEVERITIES`).
pub use craft_store::record::SEVERITIES;

/// One finding a gatherer returned, its keys in the gatherer's order; once sourced, with the
/// source it came from set on it.
#[derive(Debug, Clone, PartialEq)]
pub struct Finding(pub Obj);

impl Finding {
    /// A field as a template literal writes it (`undefined` when absent).
    #[must_use]
    pub fn js(&self, key: &str) -> String {
        js::string(self.0.get(key))
    }

    /// A field's text, '' when absent or no string.
    #[must_use]
    pub fn text(&self, key: &str) -> &str {
        self.0.text(key)
    }
}

/// One gatherer's answer: its source and findings.
#[derive(Debug, Clone, PartialEq)]
pub struct Gathered {
    pub source: String,
    pub findings: Vec<Finding>,
}

fn refused(why: &str) -> TriageError {
    TriageError::Answer {
        what: "a gatherer's answer".into(),
        why: why.to_owned(),
    }
}

impl Gathered {
    /// A gatherer's answer read, its source normalised by [`report_source`] for a report's.
    ///
    /// # Errors
    /// [`TriageError::Answer`] when it lacks what the raw schema requires: the source, the list
    /// of findings, each finding's six text fields.
    pub fn read(answer: &Json, from_report: bool) -> Result<Self, TriageError> {
        let source = answer
            .at("source")
            .as_str()
            .ok_or_else(|| refused("no source"))?;
        let list = answer
            .at("findings")
            .as_array()
            .ok_or_else(|| refused("no list of findings"))?;
        let mut findings = Vec::new();
        for f in list {
            let o = f
                .as_object()
                .ok_or_else(|| refused("a finding is no object"))?;
            if let Some(k) = FIELDS
                .iter()
                .find(|k| o.get(k).and_then(Json::as_str).is_none())
            {
                return Err(refused(&format!("a finding has no text {k}")));
            }
            findings.push(Finding(o.clone()));
        }
        let source = if from_report {
            report_source(Some(source))
        } else {
            source.to_owned()
        };
        Ok(Self { source, findings })
    }

    /// Its findings, each with the source set on it.
    pub fn sourced(&self) -> impl Iterator<Item = Finding> + '_ {
        self.findings
            .iter()
            .map(|f| Finding(f.0.clone().with("source", self.source.as_str())))
    }
}

/// A report's source: the engine that wrote it as the gatherer read it, else `report`.
#[must_use]
pub fn report_source(said: Option<&str>) -> String {
    let said = said.map(js::trim).unwrap_or_default();
    if REPORT_SOURCES.contains(&said) {
        said.to_owned()
    } else {
        "report".to_owned()
    }
}

/// The stable composite id: `source::location::title`, `no-loc` for an empty location.
#[must_use]
pub fn id_of(f: &Finding) -> String {
    let location = if js::truthy(f.0.get("location")) {
        f.js("location")
    } else {
        "no-loc".into()
    };
    format!("{}::{location}::{}", f.js("source"), f.js("title"))
}

/// A severity's rank, Critical first, compared without case; an unknown one last.
#[must_use]
pub fn severity_rank(s: &str) -> usize {
    let s = js::trim(s).to_lowercase();
    SEVERITIES
        .iter()
        .position(|x| x.eq_ignore_ascii_case(&s))
        .unwrap_or(SEVERITIES.len())
}

#[cfg(test)]
mod tests;
