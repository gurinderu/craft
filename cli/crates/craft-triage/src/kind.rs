//! The triage as a kind of run of the step protocol ([`craft_step::Kind`], realm @nick/craft,
//! nodes #610, #616): what each of its tasks is for, and a validator's answer held to the finding
//! it was asked about.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// What a triage task's answer is for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TriageKind {
    /// The gatherer of the report file's findings.
    GatherReport,
    /// The gatherer of the PR's review threads.
    GatherPr,
    /// The recall of the project's memory, its prompt's `cut` and `grouped` paths.
    Recall { cut: usize, grouped: usize },
    /// The memory's match judge.
    MatchJudge,
    /// The memory's rule judge over the `at`-th prompt of its pairs.
    RuleJudge { at: usize },
    /// The validator of the finding `id`.
    Validate { id: String },
    /// The plan agent.
    Plan,
}

/// The agents a triage task names: none — every task runs on the host's default agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Agent {}

/// A triage task's own fields: none.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Nothing {}

impl craft_step::Kind for TriageKind {
    type Agent = Agent;
    type Marks = Nothing;
    type Flags = Nothing;

    fn tag(&self) -> &'static str {
        match self {
            Self::GatherReport => "gatherReport",
            Self::GatherPr => "gatherPr",
            Self::Recall { .. } => "recall",
            Self::MatchJudge => "matchJudge",
            Self::RuleJudge { .. } => "ruleJudge",
            Self::Validate { .. } => "validate",
            Self::Plan => "plan",
        }
    }

    /// The answer as its schema shapes it; a validator's naming another finding's `stable_id` is
    /// refused and asked for again (realm @nick/craft, node #616).
    fn check(task: &craft_step::Task<Self>, answer: &Value) -> Result<Value, String> {
        let taken = craft_step::validate::check(&task.schema, Some(answer))?;
        if let Self::Validate { id } = &task.kind {
            let said = taken.get("stable_id").and_then(Value::as_str).unwrap_or("");
            if said != id {
                return Err(format!(
                    "stable_id is \"{said}\", but this finding's is \"{id}\": copy it exactly"
                ));
            }
        }
        Ok(taken)
    }
}

#[cfg(test)]
mod tests {
    use craft_step::{Kind, Model, Task};
    use serde_json::json;

    use super::TriageKind;

    #[test]
    fn each_tag_is_the_kind_its_state_spells() {
        for kind in [
            TriageKind::GatherReport,
            TriageKind::GatherPr,
            TriageKind::Recall { cut: 0, grouped: 0 },
            TriageKind::MatchJudge,
            TriageKind::RuleJudge { at: 1 },
            TriageKind::Validate { id: "a".into() },
            TriageKind::Plan,
        ] {
            assert_eq!(json!(kind)["kind"], json!(kind.tag()), "{kind:?}");
        }
    }

    #[test]
    fn a_validator_naming_another_finding_is_asked_again() {
        let schema = json!({"type": "object", "required": ["stable_id"], "properties": {"stable_id": {"type": "string"}}});
        let task = Task::new(
            "validate-0".into(),
            "validate".into(),
            "p".into(),
            Model::Opus,
            schema,
            TriageKind::Validate {
                id: "report::a.rs:1::x".into(),
            },
        );
        TriageKind::check(&task, &json!({"stable_id": "report::a.rs:1::x"})).unwrap();
        let why = TriageKind::check(&task, &json!({"stable_id": "report::b.rs:2::y"})).unwrap_err();
        assert!(why.contains("copy it exactly"), "{why}");
    }
}
