//! A parity case's arguments and scripted answers, as the run reads them.

use craft_review::memory::{PriorDecision, Scope};
use craft_store::js::Js;
use serde_json::Value;

use crate::field::{self, At};
use crate::kind::TriageKind;
use crate::run::{Answers, Args, Phase};

/// The recall's answer when a case scripts none: read, nothing recalled (the test's `MEMORY`).
const RECALLED_NOTHING: &str = r#"{"backend":"mcp iskron","why":"recalled","decisions":[]}"#;

/// A case's JSON as plain JSON, `None` when it is null.
fn plain(v: &Js) -> Option<Value> {
    (!matches!(v, Js::Null)).then(|| serde_json::from_str(&v.compact()).unwrap())
}

/// A text argument as `textArg` reads one: its `String()` when it is truthy, else ''.
fn text(args: &Js, key: &str) -> String {
    args.as_obj()
        .filter(|o| field::truthy(o, key))
        .map(|o| field::js(o, key))
        .unwrap_or_default()
}

/// The case's arguments; the craft version its record names.
pub(crate) fn args_of(case: &Js) -> Args {
    let a = case.at("args");
    let version = case.at("expected").at("record").at("craftVersion");
    Args {
        report: text(a, "report"),
        pr: text(a, "pr"),
        base: text(a, "base"),
        pr_base: text(a, "prBase"),
        repo: text(a, "repo"),
        prior_ledger: a
            .at("priorLedger")
            .as_arr()
            .unwrap_or_default()
            .iter()
            .filter_map(plain)
            .collect(),
        prior_decisions: plain(a.at("priorDecisions")).map(Ok),
        craft_version: version.as_str().unwrap_or_default().to_owned(),
    }
}

/// The answers a case scripts, every agent asked, those of `held` held back.
pub(crate) struct CaseAnswers<'a> {
    answers: &'a Js,
    held: Option<Phase>,
}

impl<'a> CaseAnswers<'a> {
    pub(crate) fn new(case: &'a Js, held: Option<Phase>) -> Self {
        Self {
            answers: case.at("answers"),
            held,
        }
    }

    /// What the case's scope check saw: the ids it names unchanged, and those it names missing
    /// among the records it was handed (`readScopeCheck`); a dead one, or one whose `unchanged`
    /// is no list, nothing.
    pub(crate) fn scope(&self, ds: &[&PriorDecision]) -> Scope {
        let answer = plain(self.answers.at("scope"));
        let read = answer.filter(|a| a.get("unchanged").is_some_and(Value::is_array));
        let named = |k: &str, id: &str| {
            read.as_ref()
                .and_then(|a| a.get(k))
                .and_then(Value::as_array)
                .is_some_and(|l| l.iter().any(|x| x == id))
        };
        let mut s = Scope::default();
        for d in ds {
            if named("unchanged", &d.id) {
                s.unchanged.insert(d.id.clone());
            }
            if named("missing", &d.id) {
                s.missing.insert(d.id.clone());
            }
        }
        s
    }
}

fn phase_of(kind: &TriageKind) -> Phase {
    match kind {
        TriageKind::GatherReport | TriageKind::GatherPr => Phase::Gather,
        TriageKind::Recall { .. } => Phase::Recall,
        TriageKind::MatchJudge => Phase::Match,
        TriageKind::RuleJudge { .. } => Phase::Rules,
        TriageKind::Validate { .. } => Phase::Validate,
        TriageKind::Plan => Phase::Plan,
    }
}

fn given(v: &Js) -> Option<Js> {
    (!matches!(v, Js::Null)).then(|| v.clone())
}

impl Answers for CaseAnswers<'_> {
    fn answer(&self, kind: &TriageKind) -> Option<Option<Js>> {
        if self.held == Some(phase_of(kind)) {
            return None;
        }
        let a = self.answers;
        Some(match kind {
            TriageKind::GatherReport => given(a.at("report")),
            TriageKind::GatherPr => given(a.at("pr")),
            TriageKind::Recall { .. } => Some(
                given(a.at("memoryRecall"))
                    .unwrap_or_else(|| craft_store::js::parse(RECALLED_NOTHING).unwrap()),
            ),
            TriageKind::MatchJudge => given(a.at("match")),
            TriageKind::RuleJudge { at } => a
                .at("rules")
                .as_arr()
                .and_then(|r| r.get(*at))
                .and_then(given),
            TriageKind::Validate { finding: id } => a
                .at("validate")
                .as_obj()
                .and_then(|o| o.get(id.as_str()))
                .and_then(given),
            TriageKind::Plan => given(a.at("plan")),
        })
    }
}
