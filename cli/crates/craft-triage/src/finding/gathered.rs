//! A gatherer's answer read, as the raw schema shapes it.

use craft_store::js::{Js, JsString};

use super::{ANSWER_FIELDS, FIELDS, Finding, report_source};
use crate::TriageError;
use crate::field;

/// One gatherer's answer: its source and findings.
#[derive(Debug, Clone, PartialEq)]
pub struct Gathered {
    pub source: JsString,
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
    match field::first_not_text(o, &FIELDS) {
        Some(k) => Err(refused(&format!("a finding has no text {k}"))),
        None => Ok(Finding(o.clone())),
    }
}

impl Gathered {
    /// A gatherer's answer read, its source normalised by [`report_source`] for a report's.
    ///
    /// # Errors
    /// [`TriageError::Answer`] when it lacks what the raw schema requires: the source, the list
    /// of findings, each finding's six text fields (a text holding an unpaired surrogate
    /// is text, as to the engine).
    pub fn read(answer: &Js, from_report: bool) -> Result<Self, TriageError> {
        let [source_key, findings_key] = ANSWER_FIELDS;
        let source = answer
            .as_obj()
            .filter(|o| o.get(source_key).is_some_and(Js::is_string))
            .map(|o| o.text_units(source_key))
            .ok_or_else(|| refused("no source"))?;
        let list = field::at(answer, findings_key)
            .as_arr()
            .ok_or_else(|| refused("no list of findings"))?;
        let findings = list.iter().map(finding).collect::<Result<_, _>>()?;
        let source = if from_report {
            report_source(source.as_str()).into()
        } else {
            source
        };
        Ok(Self { source, findings })
    }

    /// Its findings, each with the source set on it.
    pub fn sourced(&self) -> impl Iterator<Item = Finding> + '_ {
        self.findings
            .iter()
            .map(|f| Finding(f.0.clone().with("source", Js::Str(self.source.clone()))))
    }
}
