//! The Plan phase: the plan agent is handed the accepted findings with their sites, every verdict
//! and the rows settled before validation.

use std::collections::BTreeMap;

use craft_step::Model;
use craft_store::js::{Js, JsString};

use crate::TriageError;
use crate::finding::{Finding, id_of};
use crate::kind::TriageKind;
use crate::ledger::Row;
use crate::prompts::{self, Planned, Schema, directive};
use crate::sift::repeat_entry;

use super::gather::Got;
use super::sift::Sift;
use super::validate::Validated;
use super::{Answers, Args, Ask, Phase, Ready};

/// What the run hands on: the gathered findings by id, the rows settled before validation.
pub(super) struct Facts<'a> {
    pub(super) by_id: BTreeMap<JsString, &'a Finding>,
    pub(super) sifted: Vec<Row>,
}

pub(super) fn facts<'a>(got: &'a Got, sift: &Sift) -> Facts<'a> {
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
