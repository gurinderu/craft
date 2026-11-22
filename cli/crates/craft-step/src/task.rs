//! One agent the host is to run, whatever kind of run hands it out: the kind's own parts (`K` and
//! its [`Kind::Marks`] and [`Kind::Flags`]) travel flattened beside the fields every kind shares,
//! so a state file keeps one shape.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::kind::Kind;
use crate::model::Model;

/// How many times an invalid or missing answer is asked for again before its task fails.
pub const MAX_RETRIES: u32 = 2;

/// Whether a task still waits for its answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskState {
    Pending,
    Answered,
    /// Its retries are spent without a valid answer.
    Failed,
}

/// An answer file whose refusal a task's state counted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Counted {
    /// The file's print ([`crate::handoff::Written::print`]).
    pub print: String,
    /// The retries the task had when it was refused, which its set-aside name carries.
    pub at: u32,
    /// Already read again once, left in place: read again once more, it is no new answer and
    /// counts as a missing one, so a file that never moves does not hold its task forever.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub again: bool,
}

/// One agent the host is to run; `K` says what its answer is for, as the kind of run reads it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", bound = "")]
pub struct Task<K: Kind> {
    pub id: String,
    pub label: String,
    pub prompt: String,
    pub model: Model,
    pub schema: Value,
    /// The agent it runs on; `None`, the host's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<K::Agent>,
    /// The consumer repository's own agent it runs on, by the name that repository gives it: an
    /// extra lens (realm @nick/craft, node #295). The host runs it on that agent and no other.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub consumer_agent: Option<String>,
    #[serde(flatten)]
    pub kind: K,
    #[serde(flatten)]
    pub marks: K::Marks,
    pub state: TaskState,
    /// Answers asked for again so far.
    pub retries: u32,
    /// Why the last answer was refused.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer: Option<Value>,
    /// The last answer refused for not matching the schema, kept so a verifier that ran out of
    /// retries counts as an off-schema vote rather than a dead one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refused: Option<Value>,
    /// The answer file whose refusal was counted last, until it is set aside: the same file read
    /// again — its set-aside cut off or failed — is set aside then, not counted twice.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub counted: Option<Counted>,
    /// The host abandoned its agent at its deadline (`submit --abandoned`): failed for good, never
    /// held for a resume nor handed out again, and no death of its dispatch round.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub abandoned: bool,
    #[serde(flatten)]
    pub flags: K::Flags,
}

impl<K: Kind> Task<K> {
    #[must_use]
    pub fn new(
        id: String,
        label: String,
        prompt: String,
        model: Model,
        schema: Value,
        kind: K,
    ) -> Self {
        Self {
            id,
            label,
            prompt,
            model,
            schema,
            agent_type: None,
            consumer_agent: None,
            kind,
            marks: K::Marks::default(),
            state: TaskState::Pending,
            retries: 0,
            error: None,
            answer: None,
            refused: None,
            counted: None,
            abandoned: false,
            flags: K::Flags::default(),
        }
    }

    /// The task's prompt as its agent reads it; a retry's carries why the last answer was refused.
    #[must_use]
    pub fn prompt_text(&self) -> String {
        match &self.error {
            Some(e) => format!(
                "{}\n\nYour previous answer was invalid: {e}. Answer again, matching the schema exactly.",
                self.prompt
            ),
            None => self.prompt.clone(),
        }
    }

    /// Whether it still waits for its answer.
    #[must_use]
    pub fn pending(&self) -> bool {
        self.state == TaskState::Pending
    }
}
