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

    /// A verifier's answer carries every finding of its batch exactly once, as the review holds
    /// its batches; one that skips, repeats or misnumbers a finding is refused and asked again.
    fn check(task: &craft_step::Task<Self>, answer: &Value) -> Result<Value, String> {
        let answer = craft_step::validate::check(&task.schema, Some(answer))?;
        if let Self::Verify { findings, .. } = &task.kind {
            craft_step::validate::batch_indices(&answer, findings.len())?;
        }
        Ok(answer)
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

    fn verdict(index: u64) -> serde_json::Value {
        json!({"index": index, "refuted": false, "citedLineMatches": true, "reachable": true,
            "premiseSupported": true, "behaviourIntended": false, "harmSupported": true,
            "confirmedHarmLevel": "outage", "reason": "r"})
    }

    #[test]
    fn a_verifier_answer_skipping_misnumbering_or_lacking_a_finding_is_refused_and_a_whole_one_taken()
     {
        let verify = AuditKind::Verify {
            profile: "rust".into(),
            findings: vec![4, 7],
        };
        let schema = crate::prompts::verify_schema().unwrap();
        let task = Task::new(
            "v".into(),
            "v".into(),
            "p".into(),
            Model::Opus,
            schema,
            verify,
        );
        let of =
            |at: &[u64]| json!({"verdicts": at.iter().map(|&i| verdict(i)).collect::<Vec<_>>()});
        AuditKind::check(&task, &of(&[1, 0])).unwrap();
        for (bad, says) in [
            (of(&[0]), "no verdict for index 1"),
            (of(&[0, 7]), "index 7 is not a finding"),
            (of(&[0, 0]), "appears twice"),
            (of(&[]), "no verdict for index 0"),
        ] {
            let why = AuditKind::check(&task, &bad).unwrap_err();
            assert!(why.contains(says), "{bad}: {why}");
        }
    }
}
