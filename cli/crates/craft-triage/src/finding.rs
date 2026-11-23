//! A gathered finding, as `triage-findings.js` reads one: the source it came from, its stable id,
//! and the file and line its location names.

use craft_store::js::{Js, Obj, trim};

use crate::TriageError;
use crate::field;

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

/// What `content/schemas/triage-raw.schema.json` requires of a gatherer's answer.
pub const ANSWER_FIELDS: [&str; 2] = ["source", "findings"];

/// The fields the same schema requires of a finding, all text.
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
        field::js(&self.0, key)
    }

    /// A field's text, '' when absent or no string.
    #[must_use]
    pub fn text(&self, key: &str) -> &str {
        field::text(&self.0, key)
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

/// A finding of a gatherer's answer, its six fields text.
fn finding(f: &Js) -> Result<Finding, TriageError> {
    let o = f
        .as_obj()
        .ok_or_else(|| refused("a finding is no object"))?;
    match FIELDS
        .iter()
        .find(|k| o.get(**k).and_then(Js::as_str).is_none())
    {
        Some(k) => Err(refused(&format!("a finding has no text {k}"))),
        None => Ok(Finding(o.clone())),
    }
}

impl Gathered {
    /// A gatherer's answer read, its source normalised by [`report_source`] for a report's.
    ///
    /// # Errors
    /// [`TriageError::Answer`] when it lacks what the raw schema requires: the source, the list
    /// of findings, each finding's six text fields (a text with an unpaired surrogate counts as
    /// none).
    pub fn read(answer: &Js, from_report: bool) -> Result<Self, TriageError> {
        let source = field::at(answer, "source")
            .as_str()
            .ok_or_else(|| refused("no source"))?;
        let list = field::at(answer, "findings")
            .as_arr()
            .ok_or_else(|| refused("no list of findings"))?;
        let findings = list.iter().map(finding).collect::<Result<_, _>>()?;
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
            .map(|f| Finding(f.0.clone().with("source", Js::str(self.source.as_str()))))
    }
}

/// A report's source: the engine that wrote it as the gatherer read it, else `report`.
#[must_use]
pub fn report_source(said: Option<&str>) -> String {
    let said = said.map(trim).unwrap_or_default();
    if REPORT_SOURCES.contains(&said) {
        said.to_owned()
    } else {
        "report".to_owned()
    }
}

/// The stable composite id: `source::location::title`, `no-loc` for an empty location.
#[must_use]
pub fn id_of(f: &Finding) -> String {
    let location = if field::truthy(&f.0, "location") {
        f.js("location")
    } else {
        "no-loc".into()
    };
    format!("{}::{location}::{}", f.js("source"), f.js("title"))
}

/// A severity's rank, Critical first, compared without case; an unknown one last.
#[must_use]
pub fn severity_rank(s: &str) -> usize {
    let s = trim(s).to_lowercase();
    SEVERITIES
        .iter()
        .position(|x| x.eq_ignore_ascii_case(&s))
        .unwrap_or(SEVERITIES.len())
}

#[cfg(test)]
mod tests;
