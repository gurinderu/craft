//! The Gather and Validate phases of one parity case, as `triage-findings.js` runs them.

use crate::finding::Gathered;
use crate::js;
use crate::json::Json;
use crate::ledger::Row;
use crate::noise::{classified_verdict, effective_pr_base};
use crate::prior::{ledger_by_id, settled_prior};
use crate::sift::Sifted;

/// A text argument as `textArg` reads one: its `String()` when it is truthy, else ''.
pub(super) fn text(args: &Json, key: &str) -> String {
    let v = args.as_object().and_then(|o| o.get(key));
    if js::truthy(v) {
        js::string(v)
    } else {
        String::new()
    }
}

/// A list of text, the texts of it alone.
pub(super) fn strings(v: &Json) -> Vec<String> {
    let all = v.as_array().unwrap_or_default();
    all.iter()
        .filter_map(|x| x.as_str().map(str::to_owned))
        .collect()
}

/// The Gather phase: each requested source's answer, and the sources that produced nothing.
pub(super) fn gather(args: &Json, answers: &Json) -> (Vec<Gathered>, Vec<String>) {
    let (mut gathered, mut not_run) = (Vec::new(), Vec::new());
    for arg in ["report", "pr"]
        .into_iter()
        .filter(|a| !text(args, a).is_empty())
    {
        let a = answers.at(arg);
        if matches!(a, Json::Null) {
            not_run.push(arg.to_owned());
        } else {
            gathered.push(Gathered::read(a, arg == "report").unwrap());
        }
    }
    (gathered, not_run)
}

/// The Validate phase: each kept finding's verdict, the ids an agent was asked about, the dead.
pub(super) fn validate(
    args: &Json,
    answers: &Json,
    kept: &[Sifted],
) -> (Vec<Row>, Vec<String>, usize) {
    let pr_base = effective_pr_base(&text(args, "prBase"), &text(args, "base"));
    let prior = ledger_by_id(args.at("priorLedger").as_array().unwrap_or_default());
    let (mut validations, mut asked, mut unjudged) = (Vec::new(), Vec::new(), 0);
    for id in kept.iter().map(|f| f.stable_id.as_str()) {
        let v = if let Some(p) = settled_prior(&prior, id) {
            Row::carried(p)
        } else {
            asked.push(id.to_owned());
            let a = answers.at("validate").at(id);
            if matches!(a, Json::Null) {
                unjudged += 1;
                Row::unjudged(id)
            } else {
                Row::validation(a).unwrap()
            }
        };
        validations.push(classified_verdict(v, &pr_base));
    }
    (validations, asked, unjudged)
}
