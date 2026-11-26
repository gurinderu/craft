//! The run's end: the ledger the record tallies pins every row this side settled; the plan is led
//! by its banners, the record that did not land among them once it was filed.

use craft_store::js::Js;

use crate::banner::{self, Banners, Plan};
use crate::issue::issue_of;
use crate::memory::memory_record;
use crate::pinned::final_ledger;
use crate::record::{RecordInput, run_record};

use super::Args;
use super::gather::Got;
use super::plan::facts;
use super::sift::Sift;
use super::validate::Validated;

/// The finished run: the record it files and what its plan is built from — the plan agent's answer
/// and its banners, or none when the plan agent gave none.
#[derive(Debug, Clone, PartialEq)]
pub struct Finished {
    pub record: Js,
    planned: Option<Plan>,
    banners: Banners,
}

impl Finished {
    /// The plan it returns, `lost` the run's telemetry writes that did not land (`<what> — <why>`):
    /// the plan agent's answer led by its banners — a lost write's section above them all — or the
    /// failure's text after that section, as `triage-findings.js` files the record before it.
    #[must_use]
    pub fn plan(&self, lost: &[String]) -> Js {
        let section = craft_store::lost::section(lost);
        let Some(p) = &self.planned else {
            return Js::str(banner::failed(&section));
        };
        let b = Banners {
            lost_section: section,
            telemetry_lost: lost.to_vec(),
            ..self.banners.clone()
        };
        Js::Obj(banner::bannered(p.clone(), &b).0)
    }
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
            planned: None,
            banners: Banners::default(),
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
        planned: Some(p),
        banners: b,
    }
}
