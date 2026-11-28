//! The step protocol (realm @nick/craft, node #453), apart from what any one kind of run does with
//! it: the binary decides what work a run needs and starts no agent; the host runs the tasks each
//! step hands out and submits their answers, and the next step reads them. This crate holds what
//! every kind shares — the task ([`Task`]), its files and how it travels ([`handoff`]), the answer
//! taken back, checked against its schema and asked for again ([`take`], [`validate`]), the notes
//! of a round its host could not submit ([`noted`]), and the pending step ([`wire`]) —; a kind (the review, `craft-review`) brings its own phases, its task
//! kinds, agents and fields ([`Kind`]) and its finished step.

pub mod handoff;
mod kind;
pub mod left;
mod model;
pub mod noted;
pub mod stop;
pub mod take;
mod task;
#[cfg(test)]
mod test_kind;
pub mod validate;
pub mod wire;

pub use handoff::{Aside, HandoffError, Unmoved};
pub use kind::Kind;
pub use model::Model;
pub use take::Hold;
pub use task::{Counted, MAX_RETRIES, Task, TaskState};
