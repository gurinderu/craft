//! The triage of review findings (`craft:triage-findings`) as the binary runs it, the second kind
//! of the step protocol (realm @nick/craft, node #616), ported from the JavaScript triage engine
//! it replaced (its `triage-sift.mjs` and `triage-noise-class.mjs`) and held to it by
//! `content/parity/triage-cases.json` (the `parity` tests). Its steps on the protocol ([`step`]),
//! its state between them ([`state`]), its tasks' kinds ([`kind`]), and its run derived at every
//! step from its arguments and its agents' answers ([`run`]); the agents' prompts ([`prompts`]);
//! a gathered finding's identity and site ([`finding`]); repeats in one batch collapsed
//! ([`sift`]); a prior ledger's settled verdicts carried ([`prior`]) and the stand-in for a dead
//! validator ([`ledger`]); the batch sifted by the project's memory, the review's own, through its
//! open API ([`memory`]); the noise classes a verdict is read back by ([`noise`]) and the issue
//! class 1 files ([`issue`]); the plan's ledger with the rows this side settled pinned
//! ([`pinned`]); the banners that lead the plan ([`banner`]); the run record ([`record`]). Each is
//! the engine's object, its keys in the engine's order, held in the run store's
//! JavaScript-compatible value (`craft_store::js`) and read as the engine reads it ([`field`]).

pub mod banner;
pub mod field;
pub mod finding;
pub mod issue;
pub mod kind;
pub mod ledger;
pub mod memory;
pub mod noise;
#[cfg(test)]
mod parity;
pub mod pinned;
pub mod prior;
pub mod prompts;
pub mod record;
pub mod run;
pub mod sift;
pub mod state;
pub mod step;

/// Why an agent's answer could not be read as the triage needs it.
#[derive(Debug, thiserror::Error)]
pub enum TriageError {
    /// The answer is not the shape its schema promises.
    #[error("{what} is not the answer its schema promises: {why}")]
    Answer { what: String, why: String },
    /// A prompt or schema of the triage's content could not be rendered.
    #[error(transparent)]
    Content(#[from] craft_review::content::ContentError),
    #[error(transparent)]
    State(#[from] state::StateError),
    #[error(transparent)]
    Handoff(#[from] craft_step::HandoffError),
    #[error("reading the repository {}", path.display())]
    NoRepo {
        path: std::path::PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("creating {}", path.display())]
    NoDir {
        path: std::path::PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("writing {}", path.display())]
    Unwritable {
        path: std::path::PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("{} holds a triage already", .0.display())]
    RunExists(std::path::PathBuf),
    #[error("the triage in {} is done", .0.display())]
    Done(std::path::PathBuf),
    #[error("answer for {0}, which is no pending task of this triage")]
    UnknownTask(String),
    /// An argument the triage refuses before any agent.
    #[error("{0}")]
    Refused(String),
    /// The finished plan holds text JSON cannot carry.
    #[error("the finished plan cannot be given as JSON: {0}")]
    PlanNotJson(String),
    /// The run asked again only agents it had asked: a defect, never a loop.
    #[error("the triage's {0:?} phase asked no agent it had not asked before")]
    Stuck(run::Phase),
}

impl TriageError {
    /// Whether the run was refused for an argument it was given, before any work: the command
    /// exits as a refused argument does, so a host tells it from a failure (realm @nick/craft,
    /// node #523).
    #[must_use]
    pub fn refuses_argument(&self) -> bool {
        matches!(self, Self::Refused(_) | Self::NoRepo { .. })
    }
}
