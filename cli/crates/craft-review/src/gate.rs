//! The mechanical gate before the lenses (the `Gate` phase of `integrations/shared/review-profile.mjs`; the tool
//! distinction of realm @nick/craft, node #238): per language profile, the binary runs the tools
//! itself — clippy and semgrep for Rust; `nix flake check`, statix and deadnix for Nix — each
//! bounded by one time budget, as stage 5 runs git. The engine hands this to an agent only because
//! its sandbox spawns no process; reading a project's own lint recipe, which takes judgement, is
//! the reviewer's at `craft init`, not the gate's. CI is read only when the gate's own build is
//! impossible (cargo ended with no compiler error), and it informs, never certifies (`gate/ci.rs`,
//! realm @nick/craft, node #482): a red check the reviewer's CI map names for the head blocks; a
//! green one is reported and the signal stays unknown, as it does without a map, gh or network.
//! A red check this change is answerable for blocks the review before any lens; a clippy, statix
//! or deadnix diagnostic on a line the change added, and any result of semgrep's repository rules
//! in a changed file, is a seed finding every lens and verifier sees, carrying its `toolRule`; a
//! tool that is not installed is named, and the review goes on.
//! clippy and `nix flake check` build and run the branch's code (build scripts, proc macros,
//! flake checks, and the flake dev shell's `shellHook` when clippy runs inside it): a run started
//! with `--no-gate` runs none of them, and says so.

use std::ffi::OsString;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::coverage::Exit;

pub mod alone;
mod cause;
mod check;
mod ci;
#[cfg(test)]
mod ci_expr_tests;
#[cfg(test)]
mod ci_inform_tests;
mod ci_read;
#[cfg(test)]
mod ci_read_tests;
#[cfg(test)]
mod ci_reusable_tests;
#[cfg(test)]
mod ci_tests;
mod ci_verdict;
#[cfg(test)]
mod ci_world;
mod clippy;
mod devshell;
#[cfg(test)]
mod devshell_tests;
mod devshell_toolchain;
#[cfg(test)]
mod devshell_toolchain_tests;
pub(crate) mod lines;
mod lock;
#[cfg(test)]
mod locked_tests;
pub mod mutants;
mod nix;
mod nix_answer;
#[cfg(test)]
mod nix_bare_tests;
#[cfg(test)]
mod nix_broken_tests;
mod nix_fault;
mod nix_lint;
#[cfg(test)]
mod nix_provenance_tests;
#[cfg(test)]
mod nix_tests;
#[cfg(test)]
mod nothing_tests;
pub(crate) mod runner;
mod rust;
mod section;
mod semgrep;
#[cfg(test)]
pub(crate) mod tests;
pub mod unknown;
#[cfg(test)]
#[cfg(unix)]
mod unread_tests;

use check::{Acc, Cx};
pub use section::section;

/// How long the whole gate may run: with the sources' 240 s beside it, well under the 600 s the
/// driver gives `review start` (`integrations/shared/cli-review-steps.mjs`).
const BUDGET: Duration = Duration::from_secs(300);

/// How a run's gate is run.
#[derive(Debug, Clone)]
pub struct GateSetup {
    /// How long the whole gate may run.
    pub budget: Duration,
    /// The PATH its tools are looked up on, when not craft's own.
    pub path: Option<OsString>,
    /// The directory the run reviews (`path`, repository-relative): when it is a Cargo package or
    /// inside one, clippy lints that package alone (`-p`), so per-crate runs of one workspace do
    /// not lint the same packages side by side.
    pub scope: Option<String>,
    /// Where the reviewers' profiles are (`~/.craft/projects`): the CI map is read from the
    /// repository's when the gate cannot build the head itself. `None`, CI is not read.
    pub projects: Option<std::path::PathBuf>,
    /// Whether the run reviews craft's own worktree of a pull request (realm `@nick/craft`, node
    /// #517), shared by every run on its head: there the gate writes no tracked file — clippy runs
    /// with `--locked` where a lockfile is — so no run leaves it dirty for the next. In the
    /// user's own checkout, `false`: the gate builds as it always did.
    pub locked: bool,
    /// A stop asked of the run: the tool running is killed with its group and no other starts, the
    /// gate then ending with what it had.
    pub cancel: crate::cancel::Cancel,
}

impl Default for GateSetup {
    fn default() -> Self {
        Self {
            budget: BUDGET,
            path: None,
            scope: None,
            projects: None,
            locked: false,
            cancel: crate::cancel::Cancel::default(),
        }
    }
}

/// Whether a profile's gate passed, failed, could not be established, or had nothing to establish
/// — changed `.rs` files no Cargo package holds, or a Nix change with no `flake.nix` whose linters
/// ran clean: nothing to gate is no unknown signal and caps no verdict (realm @nick/craft, node
/// #487).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Pass,
    Fail,
    #[default]
    Unknown,
    Nothing,
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
    /// Whether its cargo ran inside the checkout's flake dev shell: the mutants run where it did
    /// ([`mutants`]). Optional, so a track written before it reads as outside.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub dev_shell: bool,
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
    /// The directory of the launching run's gate this run took rather than running its own
    /// (`--gate-from`, [`alone::taken`]); empty when the run gated itself or not at all.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub from: String,
    /// Why the change's lines could not be read (git's zero-context diff failed, as on a changed
    /// path that is not UTF-8): no tool diagnostic was matched to a changed line, so none of those
    /// reached the lenses as a seed. Said in the section and as a degraded note, never silent;
    /// empty when they were read.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub unread_lines: String,
    /// The mutants of the change, while they run beside the lens rounds ([`mutants`]); none when
    /// none were launched.
    #[serde(skip_serializing_if = "mutants::Mutants::is_none")]
    pub mutants: mutants::Mutants,
}

impl Gate {
    /// A run started without a gate (`--no-gate`).
    #[must_use]
    pub fn not_asked() -> Self {
        Self {
            tracks: Vec::new(),
            skipped:
                "skipped on request (`--no-gate`): no tool built, linted or ran the branch's code"
                    .into(),
            from: String::new(),
            unread_lines: String::new(),
            mutants: mutants::Mutants::default(),
        }
    }

    /// What the gate's unread changed lines cost, as the section and the degraded notes say it;
    /// `None` when they were read.
    #[must_use]
    pub fn unread_note(&self) -> Option<String> {
        (!self.unread_lines.is_empty()).then(|| {
            format!(
                "the gate could not read the change's lines ({}): no clippy, statix or deadnix diagnostic was matched to a changed line, so none reached the lenses as a seed — semgrep's results, matched by file, still did",
                self.unread_lines
            )
        })
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
    let (lines, unread_lines) = match crate::git::zero_context_diff(cwd, base) {
        Ok(d) => (lines::Lines::parse(&d), String::new()),
        Err(e) => (lines::Lines::default(), e.to_string()),
    };
    let runner = runner::Runner::new(setup.budget, setup.path.clone(), dir.join("gate"))
        .stopped_by(setup.cancel.clone());
    let mut gate = Gate {
        unread_lines,
        ..Gate::default()
    };
    let mut seeds = Vec::new();
    for t in gated {
        let cx = Cx {
            runner: &runner,
            top: &top,
            files: &t.files,
            lines: &lines,
            profile: &t.profile,
            scope: setup.scope.as_deref(),
            projects: setup.projects.as_deref(),
            locked: setup.locked,
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
