//! Mutants of the change's own lines (realm @nick/craft, node #648): whether a test fails when a
//! changed line breaks has one answer, and cargo-mutants gives it, so the binary runs it rather
//! than a lens reasoning about it. `review start` launches it once the Rust gate passed and
//! cargo-mutants answers where the gate's cargo ran ([`launch`]), as a process of its own that
//! bounds itself ([`worker`]): the driver gives `start` 600 s, most of which the gate and the
//! sources already take, so the mutants run beside the lens rounds. When the rounds end the binary
//! joins it ([`join`]) and each mutant that survived in a function the change touched is pooled as
//! a tool's finding ([`findings`]). Every run says what came of them: run, run short, or not run
//! and why. Unix only: elsewhere the run says they did not run.

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};

mod findings;
mod join;
mod launch;
mod outcomes;
mod worker;

#[cfg(test)]
use join::join;
pub(crate) use join::{abandon, join_now};
pub(crate) use launch::{Launch, launch};
pub use worker::work;

/// How long the mutants may run by default: beside the lens rounds, which take longer on most
/// changes (realm @nick/craft, node #649: to be measured).
pub const BUDGET: Duration = Duration::from_mins(10);
/// The run directory's part the worker writes into.
const DIR: &str = "mutants";

/// How a run's mutants are run.
#[derive(Debug, Clone)]
pub struct MutantsSetup {
    /// The craft binary, whose hidden `__craft-mutants` command is the worker.
    pub exe: PathBuf,
    pub budget: Duration,
    /// Off in the reviewer's profile.
    pub off: bool,
    /// The program cargo is: `cargo`, or a stand-in under test.
    pub cargo: String,
    /// The program nix is, for the dev shell: `nix`, or a stand-in under test.
    pub nix: String,
    /// Why the reviewer's profile's `[mutants]` section could not be read, the defaults taken; ''
    /// when it was.
    pub note: String,
}

/// Where a run's mutants stand.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Mutants {
    /// The worker's directory, while it is to be joined; empty when none was launched.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub dir: String,
    /// The checkout's top level and the workspace it ran in, repository-relative.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub top: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub workspace: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub base: String,
    /// Whether it was joined.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub joined: bool,
}

impl Mutants {
    /// Whether none was launched.
    #[must_use]
    pub fn is_none(&self) -> bool {
        self.dir.is_empty()
    }

    /// Whether a worker was launched and not yet joined.
    #[must_use]
    pub fn running(&self) -> bool {
        !self.dir.is_empty() && !self.joined
    }
}

/// Why the worker could not do what it was asked.
#[derive(Debug, thiserror::Error)]
pub enum MutantsError {
    #[error("{what}: {source}")]
    Io {
        what: String,
        #[source]
        source: std::io::Error,
    },
    #[error("{what}: {source}")]
    Json {
        what: String,
        #[source]
        source: serde_json::Error,
    },
}

/// The line a run says when they do not run.
fn not_run(why: &str) -> String {
    format!("mutants of the change did not run: {why}")
}

#[cfg(test)]
mod tests;
