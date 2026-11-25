//! One case of `content/parity/triage-cases.json` replayed through this crate's functions, phase
//! by phase as `triage-findings.js` runs them.

use std::collections::BTreeMap;

use crate::banner::{self, Banners, Plan};
use crate::finding::{Finding, Gathered, id_of};
use crate::issue::issue_of;
use craft_store::js::{Js, JsString};

use crate::field::At;
use crate::ledger::Row;
use crate::pinned::final_ledger;
use crate::record::{RecordInput, run_record};
use crate::sift::{Collapsed, Sifted, collapse_repeats, repeat_entry};

use super::memory::sift;
use super::phases::{gather, text as arg, validate};
use crate::memory::{Settled, memory_record};
use craft_review::memory::Memory;

/// Everything one case replays to.
pub(super) struct Replay {
    gathered: Vec<Gathered>,
    not_run: Vec<String>,
    raw: Vec<Finding>,
    collapsed: Collapsed,
    memory: Memory,
    settled: Settled,
    pub(super) sifted: Vec<Row>,
    pub(super) validations: Vec<Row>,
    pub(super) asked: Vec<JsString>,
    unjudged: usize,
}

impl Replay {
    pub(super) fn of(case: &Js) -> Self {
        let (args, answers) = (case.at("args"), case.at("answers"));
        let (gathered, not_run) = gather(args, answers);
        let raw: Vec<Finding> = gathered.iter().flat_map(Gathered::sourced).collect();
        let collapsed = collapse_repeats(
            raw.iter()
                .map(|f| Sifted::new(f.clone(), id_of(f)))
                .collect(),
        );
        let (memory, settled) = sift(args, answers, &arg(args, "base"), &collapsed.kept);
        let mut sifted: Vec<Row> = collapsed.repeated.iter().map(repeat_entry).collect();
        sifted.extend(settled.ledger.iter().cloned());
        let (validations, asked, unjudged) = validate(args, answers, &settled.to_validate);
        Self {
            gathered,
            not_run,
            raw,
            collapsed,
            memory,
            settled,
            sifted,
            validations,
            asked,
            unjudged,
        }
    }

    fn raw_by_id(&self) -> BTreeMap<JsString, &Finding> {
        self.raw.iter().map(|f| (id_of(f), f)).collect()
    }

    /// The accepted verdicts with their findings, as the plan agent is handed them.
    pub(super) fn accepted(&self) -> Js {
        let by = self.raw_by_id();
        let accepted = self.validations.iter().filter(|v| v.verdict() == "accept");
        let rows: Vec<Js> = accepted
            .map(|v| {
                let finding = by.get(&v.id()).map_or(Js::Null, |f| Js::Obj(f.0.clone()));
                Js::from(v.clone().with("finding", finding))
            })
            .collect();
        Js::Arr(rows)
    }

    fn issues(&self) -> Vec<Js> {
        let by = self.raw_by_id();
        let class_one = self
            .validations
            .iter()
            .filter(|v| v.text("action") == "issue");
        class_one
            .filter_map(|v| by.get(&v.id()).map(|f| issue_of(f, &v.id(), v)))
            .collect()
    }

    /// The findings the memory left for the validators, each with its note.
    pub(super) fn to_validate(&self) -> &[Sifted] {
        &self.settled.to_validate
    }

    /// The rows settled before validation and the verdicts, as the plan agent is handed them.
    pub(super) fn blocks(&self) -> (Js, Js) {
        let rows = |r: &[Row]| Js::Arr(r.iter().cloned().map(Js::from).collect());
        (rows(&self.validations), rows(&self.sifted))
    }

    /// The kept findings handed to a validator with the marks the memory appended to them.
    pub(super) fn noted(&self) -> impl Iterator<Item = &Sifted> {
        self.settled
            .to_validate
            .iter()
            .filter(|s| !s.memory_note.is_empty())
    }

    /// The record and the plan, from the plan agent's answer; the version from `want`.
    pub(super) fn finish(&self, plan: &Js, want: &Js) -> (Js, Js) {
        let planned = (!matches!(plan, Js::Null)).then(|| Plan::read(plan).unwrap());
        let rows = planned.as_ref().and_then(Plan::rows);
        let ledger = final_ledger(rows, &self.sifted, &self.validations);
        let issues = self.issues();
        let record = run_record(&RecordInput {
            craft_version: want.at("record").at("craftVersion").as_str().unwrap(),
            gathered: &self.gathered,
            raw: &self.raw,
            validated: self.validations.len(),
            ledger: &ledger,
            repeats: self.collapsed.repeated.len(),
            sift_counts: self.settled.counts,
            issues: issues.len(),
            memory: memory_record(&self.memory.source),
            not_run_sources: &self.not_run,
            unjudged: self.unjudged,
        });
        let Some(mut p) = planned else {
            return (record, Js::str(banner::failed("")));
        };
        if p.rows().is_some() {
            p.0.set("ledger", Js::Arr(ledger));
        }
        let refused = self.memory.refused.iter().chain(&self.settled.refused);
        let b = Banners {
            memory_degraded: self.memory.source.degraded_notes(),
            not_run_sources: self.not_run.clone(),
            unjudged: self.unjudged,
            memory: self.memory.source.line(),
            prior_refused: refused.cloned().collect(),
            rule_notices: self.settled.notices.clone(),
            issues,
            ..Banners::default()
        };
        (record, Js::Obj(banner::bannered(p, &b).0))
    }
}
