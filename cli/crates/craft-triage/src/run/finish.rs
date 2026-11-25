//! The Plan phase and the run's end: the plan agent orders the accepted findings; the ledger the
//! record tallies pins every row this side settled; the plan is led by its banners.

use std::collections::BTreeMap;

use craft_step::Model;
use craft_store::js::{Js, JsString};

use crate::TriageError;
use crate::banner::{self, Banners, Plan};
use crate::finding::{Finding, id_of};
use crate::issue::issue_of;
use crate::kind::TriageKind;
use crate::ledger::Row;
use crate::memory::memory_record;
use crate::pinned::final_ledger;
use crate::prompts::{self, Planned, Schema, directive};
use crate::record::{RecordInput, run_record};
use crate::sift::repeat_entry;

use super::gather::Got;
use super::sift::Sift;
use super::validate::Validated;
use super::{Answers, Args, Ask, Phase, Ready};

/// The finished run: the record it files and the plan it returns — the plan agent's answer led by
/// its banners, or the failure's text when the plan agent gave none.
#[derive(Debug, Clone, PartialEq)]
pub struct Finished {
    pub record: Js,
    pub plan: Js,
}

/// What the run hands on: the gathered findings by id, the rows settled before validation.
struct Facts<'a> {
    by_id: BTreeMap<JsString, &'a Finding>,
    sifted: Vec<Row>,
}

fn facts<'a>(got: &'a Got, sift: &Sift) -> Facts<'a> {
    let mut sifted: Vec<Row> = sift.collapsed.repeated.iter().map(repeat_entry).collect();
    sifted.extend(sift.settled.ledger.iter().cloned());
    Facts {
        by_id: got.raw.iter().map(|f| (id_of(f), f)).collect(),
        sifted,
    }
}

fn rows(r: &[Row]) -> Js {
    Js::Arr(r.iter().cloned().map(Js::from).collect())
}

/// The accepted verdicts with their findings, as the plan agent is handed them.
fn accepted(facts: &Facts<'_>, v: &Validated) -> Js {
    let found = |r: &Row| {
        facts
            .by_id
            .get(&r.id())
            .map_or(Js::Null, |f| Js::Obj(f.0.clone()))
    };
    let list = v.validations.iter().filter(|r| r.verdict() == "accept");
    Js::Arr(
        list.map(|r| Js::from(r.clone().with("finding", found(r))))
            .collect(),
    )
}

/// The plan agent's answer, or its ask while it is not in.
///
/// # Errors
/// When its prompt or schema cannot be rendered.
pub(super) fn plan(
    args: &Args,
    answers: &dyn Answers,
    got: &Got,
    sift: &Sift,
    v: &Validated,
) -> Result<Ready<Option<Js>>, TriageError> {
    if let Some(answer) = answers.answer(&TriageKind::Plan) {
        return Ok(Ready::Got(answer));
    }
    let f = facts(got, sift);
    let (accepted, validations, sifted) = (accepted(&f, v), rows(&v.validations), rows(&f.sifted));
    let p = Planned {
        accepted: &accepted,
        validations: &validations,
        sifted: &sifted,
    };
    Ok(Ready::Ask(
        Phase::Plan,
        vec![Ask {
            kind: TriageKind::Plan,
            id: "plan".into(),
            label: "plan".into(),
            prompt: format!("{}{}", directive(&args.repo), prompts::plan(&p)?),
            schema: Schema::Plan.value()?,
            model: Model::Opus,
        }],
    ))
}

/// The finished run from what its phases found and the plan agent's `answer`.
pub(super) fn finish(
    args: &Args,
    got: &Got,
    sift: &Sift,
    v: &Validated,
    answer: Option<&Js>,
) -> Finished {
    let f = facts(got, sift);
    let planned = answer.and_then(|a| Plan::read(a).ok());
    let ledger = final_ledger(
        planned.as_ref().and_then(Plan::rows),
        &f.sifted,
        &v.validations,
    );
    let class_one = v.validations.iter().filter(|r| r.text("action") == "issue");
    let issues: Vec<Js> = class_one
        .filter_map(|r| f.by_id.get(&r.id()).map(|x| issue_of(x, &r.id(), r)))
        .collect();
    let memory = &sift.memory;
    let record = run_record(&RecordInput {
        craft_version: &args.craft_version,
        gathered: &got.gathered,
        raw: &got.raw,
        validated: v.validations.len(),
        ledger: &ledger,
        repeats: sift.collapsed.repeated.len(),
        sift_counts: sift.settled.counts,
        issues: issues.len(),
        memory: memory_record(&memory.source),
        not_run_sources: &got.not_run,
        unjudged: v.unjudged,
    });
    let Some(mut p) = planned else {
        return Finished {
            record,
            plan: Js::str(banner::failed("")),
        };
    };
    if p.rows().is_some() {
        p.0.set("ledger", Js::Arr(ledger));
    }
    let b = Banners {
        memory_degraded: memory.source.degraded_notes(),
        not_run_sources: got.not_run.clone(),
        unjudged: v.unjudged,
        memory: memory.source.line(),
        prior_refused: memory
            .refused
            .iter()
            .chain(&sift.settled.refused)
            .cloned()
            .collect(),
        rule_notices: sift.settled.notices.clone(),
        issues,
        ..Banners::default()
    };
    Finished {
        record,
        plan: Js::Obj(banner::bannered(p, &b).0),
    }
}
