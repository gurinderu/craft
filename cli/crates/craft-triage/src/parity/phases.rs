//! The Gather and Validate phases of one parity case, as `triage-findings.js` runs them.

use crate::field;
use crate::finding::Gathered;
use craft_store::js::{Js, JsString};

use crate::field::At;
use crate::ledger::Row;
use crate::noise::{classified_verdict, effective_pr_base};
use crate::prior::{ledger_by_id, settled_prior};
use crate::sift::Sifted;

/// A text argument as `textArg` reads one: its `String()` when it is truthy, else ''.
pub(super) fn text(args: &Js, key: &str) -> String {
    args.as_obj()
        .filter(|o| field::truthy(o, key))
        .map(|o| field::js(o, key))
        .unwrap_or_default()
}

/// A list of text, the texts of it alone.
pub(super) fn strings(v: &Js) -> Vec<String> {
    let all = v.as_arr().unwrap_or_default();
    all.iter()
        .filter_map(|x| x.as_str().map(str::to_owned))
        .collect()
}

/// The Gather phase: each requested source's answer, and the sources that produced nothing.
pub(super) fn gather(args: &Js, answers: &Js) -> (Vec<Gathered>, Vec<String>) {
    let (mut gathered, mut not_run) = (Vec::new(), Vec::new());
    for arg in ["report", "pr"]
        .into_iter()
        .filter(|a| !text(args, a).is_empty())
    {
        let a = answers.at(arg);
        if matches!(a, Js::Null) {
            not_run.push(arg.to_owned());
        } else {
            gathered.push(Gathered::read(a, arg == "report").unwrap());
        }
    }
    (gathered, not_run)
}

/// The Validate phase: each kept finding's verdict, the ids an agent was asked about, the dead.
pub(super) fn validate(
    args: &Js,
    answers: &Js,
    kept: &[Sifted],
) -> (Vec<Row>, Vec<JsString>, usize) {
    let pr_base = effective_pr_base(&text(args, "prBase"), &text(args, "base"));
    let prior = ledger_by_id(args.at("priorLedger").as_arr().unwrap_or_default());
    let (mut validations, mut asked, mut unjudged) = (Vec::new(), Vec::new(), 0);
    let scripted = answers.at("validate").as_obj();
    for id in kept.iter().map(|f| &f.stable_id) {
        let v = if let Some(p) = settled_prior(&prior, id) {
            Row::carried(p)
        } else {
            asked.push(id.clone());
            let a = scripted.and_then(|o| o.get(id)).unwrap_or(&Js::Null);
            if matches!(a, Js::Null) {
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
