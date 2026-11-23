//! The Gather and Validate phases of one parity case, as `triage-findings.js` runs them.

use serde_json::Value;

use crate::finding::Gathered;
use crate::ledger::Validation;
use crate::noise::{classified_verdict, effective_pr_base};
use crate::prior::{ledger_by_id, settled_prior};
use crate::sift::Sifted;

/// A text argument as the engine reads one: its string form when given, else ''.
pub(super) fn text(args: &Value, key: &str) -> String {
    if args[key].is_null() {
        String::new()
    } else {
        args[key]
            .as_str()
            .map_or_else(|| args[key].to_string(), str::to_owned)
    }
}

pub(super) fn strings(v: &Value) -> Vec<String> {
    serde_json::from_value(v.clone()).unwrap_or_default()
}

/// The Gather phase: each requested source's answer, and the sources that produced nothing.
pub(super) fn gather(args: &Value, answers: &Value) -> (Vec<Gathered>, Vec<String>) {
    let (mut gathered, mut not_run) = (Vec::new(), Vec::new());
    for arg in ["report", "pr"]
        .into_iter()
        .filter(|a| !text(args, a).is_empty())
    {
        if answers[arg].is_null() {
            not_run.push(arg.to_owned());
        } else {
            gathered.push(Gathered::read(&answers[arg], arg == "report").unwrap());
        }
    }
    (gathered, not_run)
}

/// The Validate phase: each kept finding's verdict, the ids an agent was asked about, the dead.
pub(super) fn validate(
    args: &Value,
    answers: &Value,
    kept: &[Sifted],
) -> (Vec<Validation>, Vec<String>, usize) {
    let pr_base = effective_pr_base(&text(args, "prBase"), &text(args, "base"));
    let prior = ledger_by_id(
        args["priorLedger"]
            .as_array()
            .map_or(&[][..], Vec::as_slice),
    );
    let (mut validations, mut asked, mut unjudged) = (Vec::new(), Vec::new(), 0);
    for id in kept.iter().map(|f| &f.stable_id) {
        let v = if let Some(p) = settled_prior(&prior, id) {
            Validation::carried(p)
        } else {
            asked.push(id.clone());
            let answer = &answers["validate"][id];
            unjudged += usize::from(answer.is_null());
            if answer.is_null() {
                Validation::unjudged(id)
            } else {
                Validation::read(answer).unwrap()
            }
        };
        validations.push(classified_verdict(v, &pr_base));
    }
    (validations, asked, unjudged)
}
