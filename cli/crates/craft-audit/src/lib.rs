//! The audit of a whole project (`craft audit`) as the binary runs it, the third kind of the step
//! protocol (realm @nick/craft, node #588): one audit for every language, apart from the review of
//! a diff. Its scout lists the project's tracked files and routes each to the language profile the
//! review would give it ([`scout`]), in batches of whole files under a byte budget ([`batch`]);
//! each lens of a file's profile that judges code as it stands ([`lenses`]) reads each batch whole,
//! as many of those agents as the run's budget buys ([`plan`]); the findings at Medium and above
//! are verified, the rest held apart by count ([`pool`]); the report says what was read and what
//! was not ([`report`]), and the run files one record ([`record`]). Its tasks' kinds ([`kind`]),
//! prompts ([`prompts`]), state between steps ([`state`]) and steps ([`step`]).

pub mod batch;
pub mod kind;
pub mod lenses;
pub mod plan;
pub mod pool;
pub mod prompts;
pub mod record;
pub mod report;
pub mod scout;
pub mod state;
pub mod step;

/// Why an audit step could not be taken.
#[derive(Debug, thiserror::Error)]
pub enum AuditError {
    /// A prompt, a schema or a profile of craft's content could not be read.
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
    /// The repository's tracked files could not be listed.
    #[error("listing the tracked files of {}: {why}", path.display())]
    NotGit {
        path: std::path::PathBuf,
        why: String,
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
    #[error("{} holds an audit already", .0.display())]
    RunExists(std::path::PathBuf),
    #[error("the audit in {} is done: it left no file unread and no finding unjudged, and no record of it waits to be filed", .0.display())]
    Done(std::path::PathBuf),
    #[error("answer for {0}, which is no pending task of this audit")]
    UnknownTask(String),
    /// An argument the audit refuses before any agent.
    #[error("{0}")]
    Refused(String),
}

impl AuditError {
    /// Whether the audit was refused for an argument it was given, before any work: the command
    /// exits as a refused argument does, so a host tells it from a failure (realm @nick/craft,
    /// node #523).
    #[must_use]
    pub fn refuses_argument(&self) -> bool {
        matches!(
            self,
            Self::Refused(_) | Self::NoRepo { .. } | Self::NotGit { .. }
        )
    }
}

#[cfg(test)]
mod tests {
    use super::AuditError;

    #[test]
    fn a_refused_argument_a_missing_repository_and_no_git_checkout_are_refusals_and_nothing_else_is()
     {
        let gone = || std::io::Error::other("gone");
        for refusal in [
            AuditError::Refused("blank path".into()),
            AuditError::NoRepo {
                path: "/x".into(),
                source: gone(),
            },
            AuditError::NotGit {
                path: "/x".into(),
                why: "not a git repository".into(),
            },
        ] {
            assert!(refusal.refuses_argument(), "{refusal}");
        }
        for failure in [
            AuditError::RunExists("/x".into()),
            AuditError::Done("/x".into()),
            AuditError::UnknownTask("t".into()),
            AuditError::Unwritable {
                path: "/x".into(),
                source: gone(),
            },
        ] {
            assert!(!failure.refuses_argument(), "{failure}");
        }
    }
}
