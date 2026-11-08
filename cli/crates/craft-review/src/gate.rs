//! The mechanical gate before the lenses (the `Gate` phase of `lib/review-profile.mjs`; the tool
//! distinction of realm @nick/craft, node #238): per language profile, the binary runs the tools
//! itself — clippy and semgrep for Rust; `nix flake check`, statix and deadnix for Nix — each
//! bounded by one time budget, as stage 5 runs git. The engine hands this to an agent only because
//! its sandbox spawns no process; reading CI and a project's own lint recipe, which takes judgement,
//! is left out and named. A red check this change is answerable for blocks the review before any
//! lens; a tool's diagnostic on a line the change added is a seed finding every lens and verifier
//! sees, carrying its `toolRule`; a tool that is not installed is named, and the review goes on.

use std::ffi::OsString;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::coverage::Exit;

mod check;
mod lines;
mod nix;
mod runner;
mod rust;
mod section;
#[cfg(test)]
mod tests;

use check::{Acc, Cx};
pub use section::section;

/// How long the whole gate may run: with the sources' 240 s beside it, well under the 600 s the
/// driver gives `review start` (`lib/cli-review-steps.mjs`).
const BUDGET: Duration = Duration::from_secs(300);

/// How a run's gate is run.
#[derive(Debug, Clone)]
pub struct GateSetup {
    /// How long the whole gate may run.
    pub budget: Duration,
    /// The PATH its tools are looked up on, when not craft's own.
    pub path: Option<OsString>,
}

impl Default for GateSetup {
    fn default() -> Self {
        Self {
            budget: BUDGET,
            path: None,
        }
    }
}

/// Whether a profile's gate passed, failed, or could not be established.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Pass,
    Fail,
    #[default]
    Unknown,
}

/// One profile's gate as it came out.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Track {
    pub profile: String,
    pub status: Status,
    /// What ran and how each came out, one line: what a verifier re-runs a tool's finding by.
    pub provenance: String,
    /// The red checks this change is answerable for: any blocks the review.
    pub failed_checks: Vec<String>,
    /// The tools not installed, each skipped.
    pub missing: Vec<String>,
    pub notes: Vec<String>,
    /// How many seed findings it gave the lenses.
    pub seeds: usize,
}

/// A run's gate: each profile's that has one, in the tracks' order. Optional, so a state written
/// before it reads as a run without one.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Gate {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tracks: Vec<Track>,
    /// Why no gate ran at all, when none did.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub skipped: String,
}

impl Gate {
    /// A run started without a gate.
    #[must_use]
    pub fn not_asked() -> Self {
        Self {
            tracks: Vec::new(),
            skipped: "the run was started without one".into(),
        }
    }

    /// The provenance a verifier of `profile`'s finding is told, '' when its profile had no gate.
    #[must_use]
    pub fn provenance(&self, profile: &str) -> &str {
        self.tracks
            .iter()
            .find(|t| t.profile == profile)
            .map_or("", |t| t.provenance.as_str())
    }

    /// The exit a red gate takes before any lens: Block, as `gateFailedExit` words it.
    #[must_use]
    pub fn exit(&self) -> Option<Exit> {
        let red: Vec<&str> = self
            .tracks
            .iter()
            .filter(|t| t.status == Status::Fail)
            .map(|t| t.profile.as_str())
            .collect();
        (!red.is_empty()).then(|| Exit {
            verdict: "Block".into(),
            line: format!(
                "⛔ Block — mechanical gate is red ({}). Fix the gate before a semantic review is worthwhile.",
                red.join(", ")
            ),
            not_run: None,
            listed: None,
        })
    }
}

/// The gate of each track of `tracks` whose profile has one, over the change in `cwd` against
/// `base`; the tools' output kept under `dir`. Returns it and its seed findings, each pooled as a
/// round-0 finding of its profile.
#[must_use]
pub fn run(
    cwd: &Path,
    base: &str,
    tracks: &[crate::state::Track],
    setup: &GateSetup,
    dir: &Path,
) -> (Gate, Vec<Value>) {
    let gated: Vec<&crate::state::Track> = tracks
        .iter()
        .filter(|t| matches!(t.profile.as_str(), "rust" | "nix"))
        .collect();
    if gated.is_empty() {
        return (Gate::default(), Vec::new());
    }
    let top = crate::git::toplevel(cwd).unwrap_or_else(|_| cwd.to_owned());
    let lines = crate::git::zero_context_diff(cwd, base)
        .map(|d| lines::Lines::parse(&d))
        .unwrap_or_default();
    let runner = runner::Runner::new(setup.budget, setup.path.clone(), dir.join("gate"));
    let mut gate = Gate::default();
    let mut seeds = Vec::new();
    for t in gated {
        let cx = Cx {
            runner: &runner,
            top: &top,
            files: &t.files,
            lines: &lines,
            profile: &t.profile,
        };
        let mut acc = Acc::default();
        if t.profile == "rust" {
            rust::gate(&cx, &mut acc);
        } else {
            nix::gate(&cx, &mut acc);
        }
        let (track, found) = acc.into_track(&t.profile);
        gate.tracks.push(track);
        seeds.extend(found);
    }
    (gate, seeds)
}
