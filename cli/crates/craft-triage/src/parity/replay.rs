//! One case of `content/parity/triage-cases.json` replayed through this crate's functions, phase
//! by phase as `triage-findings.js` runs them.

use std::collections::HashMap;

use serde_json::{Map, Value, json};

use crate::banner::{self, Banners, Plan};
use crate::finding::{Finding, Gathered, id_of};
use crate::issue::{Issue, issue_of};
use crate::ledger::{LedgerEntry, Validation};
use crate::pinned::final_ledger;
use crate::record::{RecordInput, run_record};
use crate::sift::{Collapsed, Sifted, collapse_repeats, repeat_entry};

use super::phases::{gather, strings, validate};

/// Everything one case replays to.
pub(super) struct Replay {
    gathered: Vec<Gathered>,
    not_run: Vec<String>,
    raw: Vec<Finding>,
    collapsed: Collapsed,
    pub(super) sifted: Vec<LedgerEntry>,
    pub(super) validations: Vec<Validation>,
    pub(super) asked: Vec<String>,
    unjudged: usize,
}

impl Replay {
    pub(super) fn of(case: &Value) -> Self {
        let (args, answers) = (&case["args"], &case["answers"]);
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
    pub(super) fn accepted(&self) -> Value {
        let by = self.raw_by_id();
        let rows: Vec<Value> = self
            .validations
            .iter()
            .filter(|v| v.verdict == "accept")
            .map(|v| {
                let mut o = serde_json::to_value(v).unwrap();
                o["finding"] = json!(by.get(&v.stable_id));
                o
            })
            .collect();
        json!(rows)
    }

    fn issues(&self) -> Vec<Issue> {
        let by = self.raw_by_id();
        let class_one = self
            .validations
            .iter()
            .filter(|v| v.action.as_deref() == Some("issue"));
        class_one
            .filter_map(|v| by.get(&v.stable_id).map(|f| issue_of(f, &v.stable_id, v)))
            .collect()
    }

    /// The record and the plan, from the plan agent's answer; the memory's parts from `want`.
    pub(super) fn finish(&self, plan: &Value, want: &Value) -> (Value, Value) {
        let planned = (!plan.is_null()).then(|| Plan::read(plan).unwrap());
        let rows: Option<Vec<LedgerEntry>> = planned
            .as_ref()
            .and_then(|p| serde_json::from_value(p.ledger.clone()).ok());
        let ledger = final_ledger(rows.as_deref(), &self.sifted, &self.validations);
        let issues = self.issues();
        let mut sift_counts: Map<String, Value> = want["record"]["triage"]["sifted"]
            .as_object()
            .unwrap()
            .clone();
        sift_counts.remove("repeats");
        let record = run_record(&RecordInput {
            craft_version: want["record"]["craftVersion"].as_str().unwrap(),
            gathered: &self.gathered,
            raw: &self.raw,
            validated: self.validations.len(),
            ledger: &ledger,
            repeats: self.collapsed.repeated.len(),
            sift_counts,
            issues: issues.len(),
            memory: want["record"]["memory"].clone(),
            not_run_sources: &self.not_run,
            unjudged: self.unjudged,
        });
        let Some(mut p) = planned else {
            return (record, json!(banner::failed("")));
        };
        if rows.is_some() {
            p.ledger = serde_json::to_value(&ledger).unwrap();
        }
        let b = Banners {
            memory_degraded: strings(&want["plan"]["memoryDegraded"]),
            not_run_sources: self.not_run.clone(),
            unjudged: self.unjudged,
            memory: want["plan"]["memory"].as_str().unwrap().to_owned(),
            prior_refused: strings(&want["plan"]["priorDecisionsNotApplied"]),
            rule_notices: strings(&want["plan"]["ruleNotices"]),
            issues,
            ..Banners::default()
        };
        (
            record,
            serde_json::to_value(banner::bannered(p, &b)).unwrap(),
        )
    }
}
