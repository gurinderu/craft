//! The step protocol (realm @nick/craft, node #453), apart from what any one kind of run does with
//! it: the binary decides what work a run needs and starts no agent; the host runs the tasks each
//! step hands out and submits their answers, and the next step reads them. This crate holds what
//! every kind shares — the task ([`Task`]), its files and how it travels ([`handoff`]), the answer
//! taken back, checked against its schema and asked for again ([`take`], [`validate`]), and the
//! pending step ([`wire`]) —; a kind (the review, `craft-review`) brings its own phases, its task
//! kinds ([`Kind`]) and its finished step.

pub mod agent;
pub mod handoff;
pub mod take;
mod task;
pub mod validate;
pub mod wire;

pub use handoff::HandoffError;
pub use take::{Hold, Kind};
pub use task::{MAX_RETRIES, Task, TaskState};
