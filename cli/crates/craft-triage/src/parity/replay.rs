//! One case of `content/parity/triage-cases.json` replayed through this crate's functions, phase
//! by phase as `triage-findings.js` runs them.

use std::collections::HashMap;

use crate::banner::{self, Banners, Plan};
use crate::finding::{Finding, Gathered, id_of};
use crate::issue::issue_of;
use crate::json::Json;
use crate::ledger::Row;
use crate::pinned::final_ledger;
use crate::record::{RecordInput, SiftCounts, run_record};
use crate::sift::{Collapsed, Sifted, collapse_repeats, repeat_entry};

use super::phases::{gather, strings, validate};

/// Everything one case replays to.
pub(super) struct Replay {
    gathered: Vec<Gathered>,
    not_run: Vec<String>,
    raw: Vec<Finding>,
    collapsed: Collapsed,
    pub(super) sifted: Vec<Row>,
    pub(super) validations: Vec<Row>,
    pub(super) asked: Vec<String>,
    unjudged: usize,
}

/// A count of the expected record's sift part.
fn counted(sifted: &Json, key: &str) -> usize {
    let Json::Number(n) = sifted.at(key) else {
        panic!("no count {key}")
    };
    usize::try_from(n.as_u64().unwrap()).unwrap()
}

impl Replay {
    pub(super) fn of(case: &Json) -> Self {
        let (args, answers) = (case.at("args"), case.at("answers"));
        let (gathered, not_run) = gather(args, answers);
        let raw: Vec<Finding> = gathered.iter().flat_map(Gathered::sourced).collect();
        let collapsed = collapse_repeats(
            raw.iter()
                .map(|f| Sifted::new(f.clone(), id_of(f)))
                .collect(),
        );
        let sifted = collapsed.repeated.iter().map(repeat_entry).collect();
        let (validations, asked, unjudged) = validate(args, answers, &collapsed.kept);
        Self {
            gathered,
            not_run,
            raw,
            collapsed,
            sifted,
            validations,
            asked,
            unjudged,
        }
    }

    fn raw_by_id(&self) -> HashMap<String, &Finding> {
        self.raw.iter().map(|f| (id_of(f), f)).collect()
    }

    /// The accepted verdicts with their findings, as the plan agent is handed them.
    pub(super) fn accepted(&self) -> Json {
        let by = self.raw_by_id();
        let accepted = self.validations.iter().filter(|v| v.verdict() == "accept");
        let rows: Vec<Json> = accepted
            .map(|v| {
                let finding = by
                    .get(v.id())
                    .map_or(Json::Null, |f| Json::Object(f.0.clone()));
                Json::from(v.clone().with("finding", finding))
            })
            .collect();
        Json::from(rows)
    }

    fn issues(&self) -> Vec<Json> {
        let by = self.raw_by_id();
        let class_one = self
            .validations
            .iter()
            .filter(|v| v.text("action") == "issue");
        class_one
            .filter_map(|v| by.get(v.id()).map(|f| issue_of(f, v.id(), v)))
            .collect()
    }

    /// The record and the plan, from the plan agent's answer; the memory's parts from `want`.
    pub(super) fn finish(&self, plan: &Json, want: &Json) -> (Json, Json) {
        let planned = (!matches!(plan, Json::Null)).then(|| Plan::read(plan).unwrap());
        let rows = planned.as_ref().and_then(Plan::rows);
        let ledger = final_ledger(rows, &self.sifted, &self.validations);
        let issues = self.issues();
        let s = want.at("record").at("triage").at("sifted");
        let sift_counts = SiftCounts {
            rejected_before: counted(s, "rejectedBefore"),
            deferred: counted(s, "deferred"),
            covered: counted(s, "covered"),
            conflict: counted(s, "conflict"),
            reraised: counted(s, "reraised"),
        };
        let record = run_record(&RecordInput {
            craft_version: want.at("record").at("craftVersion").as_str().unwrap(),
            gathered: &self.gathered,
            raw: &self.raw,
            validated: self.validations.len(),
            ledger: &ledger,
            repeats: self.collapsed.repeated.len(),
            sift_counts,
            issues: issues.len(),
            memory: want.at("record").at("memory").clone(),
            not_run_sources: &self.not_run,
            unjudged: self.unjudged,
        });
        let Some(mut p) = planned else {
            return (record, Json::from(banner::failed("")));
        };
        if p.rows().is_some() {
            p.0.set("ledger", ledger);
        }
        let w = want.at("plan");
        let b = Banners {
            memory_degraded: strings(w.at("memoryDegraded")),
            not_run_sources: self.not_run.clone(),
            unjudged: self.unjudged,
            memory: w.at("memory").as_str().unwrap().to_owned(),
            prior_refused: strings(w.at("priorDecisionsNotApplied")),
            rule_notices: strings(w.at("ruleNotices")),
            issues,
            ..Banners::default()
        };
        (record, Json::Object(banner::bannered(p, &b).0))
    }
}
