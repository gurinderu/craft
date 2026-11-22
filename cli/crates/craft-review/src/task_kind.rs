//! The review as a kind of run of the step protocol ([`craft_step::Kind`]): its tasks name the
//! review's agents and carry the CONSUMERS lines, an agent that could not
//! look fails at once, a batch verdict is checked beside the schema, and the CONSUMERS lines an
//! answer left unmarked are kept.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::agent::AgentKind;
use crate::state::{Task, TaskKind};
use crate::validate;

/// A review task's CONSUMERS lines, kept right after its kind in the state.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Marks {
    /// The CONSUMERS lines (`file:line`) its prompt lists, each of which its answer is to mark.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub consumers: Vec<String>,
    /// The CONSUMERS lines its taken answer left unmarked, reported as unchecked (realm
    /// @nick/craft, node #531).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unmarked: Vec<String>,
}

/// A review task's flags, kept last in the state: none since no task reaches for the code graph's
/// MCP tools — a metrics lens and its verifier judge from the numbers in their prompt.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Flags {}

impl craft_step::Kind for TaskKind {
    type Agent = AgentKind;
    type Marks = Marks;
    type Flags = Flags;

    fn tag(&self) -> &'static str {
        match self {
            Self::Scout { .. } => "scout",
            Self::Lens { .. } => "lens",
            Self::Seam { .. } => "seam",
            Self::Dedup => "dedup",
            Self::Verify { .. } => "verify",
            Self::VerifyBatch { .. } => "verifyBatch",
            Self::Adjudicate { .. } => "adjudicate",
            Self::CarryCheck { .. } => "carryCheck",
            Self::Recall { .. } => "recall",
            Self::RedTeam { .. } => "redTeam",
            Self::MatchJudge => "matchJudge",
            Self::RuleJudge => "ruleJudge",
            Self::Warmup => "warmup",
            Self::Critic { .. } => "critic",
            Self::CriticLens { .. } => "criticLens",
            Self::Extra { .. } => "extra",
        }
    }

    fn blocked(task: &Task, answer: &Value) -> Option<String> {
        crate::blocked::said(&task.schema, answer).map(|why| crate::blocked::failure(&why))
    }

    fn check(task: &Task, answer: &Value) -> Result<Value, String> {
        validate::check(task, Some(answer))
    }

    fn taken(task: &mut Task, answer: &Value) {
        // Reported as unchecked, never asked for again (realm @nick/craft, node #531).
        task.marks.unmarked = validate::unmarked(answer, &task.marks.consumers);
    }
}

#[cfg(test)]
mod tests {
    use craft_step::Kind;
    use serde_json::json;

    use crate::state::TaskKind;

    #[test]
    fn each_tag_is_the_kind_its_state_spells() {
        let s = String::new;
        for kind in [
            TaskKind::Scout { profile: s() },
            TaskKind::Lens {
                profile: s(),
                lens: s(),
                round: 1,
                slice: None,
            },
            TaskKind::Seam { profile: s() },
            TaskKind::Dedup,
            TaskKind::Verify {
                finding: 0,
                voter: 0,
            },
            TaskKind::VerifyBatch {
                findings: Vec::new(),
            },
            TaskKind::Adjudicate { prior: 0 },
            TaskKind::CarryCheck { prior: 0 },
            TaskKind::Recall { cut: 0, grouped: 0 },
            TaskKind::RedTeam { prior: 0 },
            TaskKind::MatchJudge,
            TaskKind::RuleJudge,
            TaskKind::Warmup,
            TaskKind::Critic { profile: s() },
            TaskKind::CriticLens {
                profile: s(),
                lens: s(),
            },
            TaskKind::Extra { agent: s() },
        ] {
            assert_eq!(json!(kind)["kind"], json!(kind.tag()), "{kind:?}");
        }
    }
}
