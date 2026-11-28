//! The audit as a kind of run of the step protocol ([`craft_step::Kind`]): what each of its tasks is
//! for, and a lens that said it could not look failed rather than read as a clean batch.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// What an audit task's answer is for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AuditKind {
    /// The lens `lens` of `profile` over its part's batch `batch`.
    Lens {
        profile: String,
        lens: String,
        batch: usize,
    },
    /// The verifier of the pooled findings `findings` (their indices in the pool), all `profile`'s.
    Verify {
        profile: String,
        findings: Vec<usize>,
    },
}

/// An audit task's own fields: none.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Nothing {}

impl craft_step::Kind for AuditKind {
    type Agent = craft_review::agent::AgentKind;
    type Marks = Nothing;
    type Flags = Nothing;

    fn tag(&self) -> &'static str {
        match self {
            Self::Lens { .. } => "lens",
            Self::Verify { .. } => "verify",
        }
    }

    /// A lens or verifier that said it could not read the code fails, its batch unread.
    fn blocked(task: &craft_step::Task<Self>, answer: &Value) -> Option<String> {
        craft_review::blocked::said(&task.schema, answer)
            .map(|why| craft_review::blocked::failure(&why))
    }
}

#[cfg(test)]
mod tests {
    use craft_step::{Kind, Model, Task};
    use serde_json::json;

    use super::AuditKind;

    fn lens() -> AuditKind {
        AuditKind::Lens {
            profile: "rust".into(),
            lens: "safety".into(),
            batch: 2,
        }
    }

    #[test]
    fn each_tag_is_the_kind_its_state_spells() {
        let verify = AuditKind::Verify {
            profile: "rust".into(),
            findings: vec![0, 3],
        };
        for kind in [lens(), verify] {
            assert_eq!(json!(kind)["kind"], json!(kind.tag()), "{kind:?}");
        }
        assert_eq!(json!(lens())["batch"], 2);
    }

    #[test]
    fn a_lens_that_could_not_look_is_blocked_and_one_that_looked_is_not() {
        let schema = craft_review::content::schema("findings").unwrap();
        let task = Task::new(
            "lens".into(),
            "l".into(),
            "p".into(),
            Model::Opus,
            schema,
            lens(),
        );
        let said = json!({"lens": "safety", "findings": [], "blocked": {"couldNotLook": true, "what": "sandbox"}});
        let why = AuditKind::blocked(&task, &said).unwrap();
        assert!(why.contains("sandbox"), "{why}");
        let looked = json!({"lens": "safety", "findings": [], "blocked": {"couldNotLook": false}});
        assert_eq!(AuditKind::blocked(&task, &looked), None);
    }
}
