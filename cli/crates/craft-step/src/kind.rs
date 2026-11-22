//! What a kind of run brings to the tasks it hands out: what their answers are for (the kind
//! itself, its `kind` tag on the wire), the agents it names, the fields of its own a task carries,
//! and what it adds to taking an answer.

use std::fmt::Debug;

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::task::Task;
use crate::validate;

/// A kind of run's part of its tasks; each hook's default adds nothing.
///
/// The kind's own fields travel flattened at two places of a task's state, so a kind keeps the
/// shape its state file had: [`Kind::Marks`] right after the kind, [`Kind::Flags`] after every
/// field the kinds share.
pub trait Kind: Debug + Clone + PartialEq + Serialize + DeserializeOwned {
    /// The agents a task of this kind may name, in host-neutral tokens its hosts map.
    type Agent: Debug + Clone + PartialEq + Serialize + DeserializeOwned;
    /// Its fields beside the kind (the review's CONSUMERS lines).
    type Marks: Debug + Clone + PartialEq + Default + Serialize + DeserializeOwned;
    /// Its fields after the shared ones (the review has none today).
    type Flags: Debug + Clone + PartialEq + Default + Serialize + DeserializeOwned;

    /// What the task is for, as the host reads it off the wire's `kind` (its deadline is set by it).
    fn tag(&self) -> &'static str;

    /// What the kind tells the host of the task beside the shared fields, each key with its value.
    fn wire(_task: &Task<Self>) -> Vec<(&'static str, Value)> {
        Vec::new()
    }

    /// The failure of a task whose raw `answer` says its agent could not do the work, read before
    /// the answer is held to its schema; `None`, it did not say so.
    fn blocked(_task: &Task<Self>, _answer: &Value) -> Option<String> {
        None
    }

    /// The answer `task` can use, as JSON, or why not in one line: by default, the answer as it
    /// matches the task's schema; a kind adds its own checks after the schema's.
    ///
    /// # Errors
    /// Why the answer is refused, in one line.
    fn check(task: &Task<Self>, answer: &Value) -> Result<Value, String> {
        validate::check(&task.schema, Some(answer))
    }

    /// What the kind keeps of an accepted `answer` beside it.
    fn taken(_task: &mut Task<Self>, _answer: &Value) {}
}
