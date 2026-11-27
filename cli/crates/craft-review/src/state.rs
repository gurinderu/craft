//! A run's state between steps, kept in `state.json` in its run directory: the change, the
//! current phase, the tasks the host is to run, and what their answers said.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::critic::Critic;
use crate::extra::Extra;
use crate::gate::Gate;
use crate::git::Diff;
use crate::memory::Memory;
use crate::plan::Plan;
use crate::prompts::PromptContext;
use crate::rereview::Chain;
use crate::rounds::Rounds;
use crate::units::Units;

pub use craft_step::{MAX_RETRIES, TaskState};
pub use dirty::dirty_of;

mod dirty;

/// The state file's format; a run written by another format is refused, not misread. Format 7
/// came with 0.59.0, whose metrics lenses and their verifier judge from the graph's numbers the
/// binary read at the start, which no run of format 6 holds (realm @nick/craft, node #618).
pub const STATE_VERSION: u32 = 7;

/// Why the run state at `path`, of format `found`, is refused, and what to do: a run an earlier
/// craft wrote cannot go on, so a new review is started; one a newer craft wrote goes on under it.
fn refusal(path: &Path, found: u32) -> String {
    let path = path.display();
    if found < STATE_VERSION {
        format!(
            "the run state {path} was written by a craft before 0.59.0 (format {found}); this \
             craft reads format {STATE_VERSION} only and cannot go on with it: start a new review \
             — `craft review start`, or a new launch of the review workflow"
        )
    } else {
        format!(
            "the run state {path} was written by a newer craft (format {found}); this craft reads \
             format {STATE_VERSION} only: go on with the run under the craft that started it, or \
             update this one"
        )
    }
}

/// Why a run's state could not be read or written.
#[derive(Debug, thiserror::Error)]
pub enum StateError {
    #[error("reading the run state {}", path.display())]
    Unreadable {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("parsing the run state {}", path.display())]
    Malformed {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("{}", refusal(path, *found))]
    Version { path: PathBuf, found: u32 },
    #[error("the run state {} names no diff.dirty", path.display())]
    NoDirty { path: PathBuf },
    #[error(transparent)]
    Encode(#[from] serde_json::Error),
    #[error("writing {}", path.display())]
    Unwritable {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

/// Where a run stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Scout,
    /// The red team on each resolved Critical or High prior, after its adjudicator.
    #[serde(rename = "red-team")]
    RedTeam,
    Lenses,
    /// The coordinator of each profile under unit mode, after the last lens round.
    Seam,
    Dedup,
    Verify,
    /// The memory's match judge on the near misses between records and findings.
    Match,
    /// The memory's rule judge on the findings in a project rule's scope.
    Rules,
    /// The completeness critic of each profile whose plan is large or security-sensitive.
    Critic,
    /// The lenses the completeness critic admitted.
    #[serde(rename = "critic-lenses")]
    CriticLenses,
    Done,
}

/// What a task's answer is for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TaskKind {
    /// The scout of `profile`'s part of the change.
    Scout {
        profile: String,
    },
    Lens {
        profile: String,
        lens: String,
        round: u32,
        /// The key of the slice it judges under unit mode; `None`, its profile's whole part.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        slice: Option<String>,
    },
    /// The coordinator of `profile`'s units after the lens rounds (realm @nick/craft, #321).
    Seam {
        profile: String,
    },
    Dedup,
    /// Vote `voter` of finding `finding`'s panel.
    Verify {
        finding: usize,
        voter: u32,
    },
    VerifyBatch {
        findings: Vec<usize>,
    },
    /// The adjudicator of the prior round's finding `prior` (`Chain::priors`).
    Adjudicate {
        prior: usize,
    },
    /// The carry-check of the prior round's finding `prior`, which its author set aside.
    CarryCheck {
        prior: usize,
    },
    /// The recall of the project's memory; `cut` changed paths its prompt covers by no entry,
    /// `grouped` those it recalls by their directory, past its bound of listed paths.
    Recall {
        cut: usize,
        #[serde(default, skip_serializing_if = "is_zero")]
        grouped: usize,
    },
    /// The red team attacking the fix of the prior round's finding `prior`, adjudicated resolved.
    RedTeam {
        prior: usize,
    },
    /// The memory's match judge.
    MatchJudge,
    /// The memory's rule judge.
    RuleJudge,
    /// The index warm-up agent earlier releases dispatched beside the scouts; none is made now —
    /// the binary indexes the graph itself (realm @nick/craft, node #529) —, kept so a state
    /// written before reads.
    Warmup,
    /// The completeness critic of `profile`'s plan.
    Critic {
        profile: String,
    },
    /// A lens of `profile` the completeness critic admitted.
    CriticLens {
        profile: String,
        lens: String,
    },
    /// The consumer's own agent `agent`, run as an extra lens beside the first round.
    Extra {
        agent: String,
    },
}

/// One agent the host is to run, its answer for what [`TaskKind`] says ([`craft_step::Task`]).
pub type Task = craft_step::Task<TaskKind>;

pub use crate::task_kind::{Flags, Marks};

/// One profile's part of a run: the changed files it takes, what its scout planned, and how far
/// its lens rounds went.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub profile: String,
    pub files: Vec<String>,
    /// What its scout's answer planned; `None` until it is in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<Plan>,
    /// The lens rounds it has run.
    #[serde(default)]
    pub rounds: u32,
    /// Its last round added nothing new, or no lens that found something may run again — none
    /// within their own round limit (realm @nick/craft, nodes #625, #632).
    #[serde(default)]
    pub dry: bool,
    /// Its changed lines hold a query string ([`crate::embedded_sql`]), so its plan takes the
    /// `sql-queries` lens when its profile holds one.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub embedded_sql: bool,
    /// Its part of the change adds a module, a crate, a public type or a format
    /// ([`crate::design`]), so its plan takes the `design` lens when its profile holds one.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub design: bool,
    /// The old paths of its files the change renamed ([`crate::runbook`]): read beside `files` by
    /// its scout and lenses, so git shows each rename, but not counted among its files.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub renamed_from: Vec<String>,
    /// The lens signals its part shows ([`crate::lens_signal`]); `None` — unknown, which admits
    /// every signal-gated lens — until they are read, when they could not be, and in a state
    /// written before they were.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signals: Option<Vec<String>>,
    /// The lines its files changed, added and removed ([`crate::size`]), which size its plan;
    /// `None` until counted, when git could not count them, and in a state written before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changed_lines: Option<u64>,
}

impl Track {
    #[must_use]
    pub fn new(profile: &str, files: Vec<String>) -> Self {
        Self {
            profile: profile.to_owned(),
            files,
            plan: None,
            rounds: 0,
            dry: false,
            embedded_sql: false,
            design: false,
            renamed_from: Vec::new(),
            signals: None,
            changed_lines: None,
        }
    }

    /// The paths its scout and lenses read: its files, then the old paths of those renamed.
    #[must_use]
    pub fn read_paths(&self) -> Vec<String> {
        self.files
            .iter()
            .chain(&self.renamed_from)
            .cloned()
            .collect()
    }

    /// Whether it runs another lens round: planned, not dry, and its plan's rounds not spent.
    #[must_use]
    pub fn live(&self) -> bool {
        self.plan
            .as_ref()
            .is_some_and(|p| !self.dry && self.rounds < p.max_rounds)
    }
}

/// Everything a run keeps between steps.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunState {
    pub version: u32,
    pub context: PromptContext,
    pub diff: Diff,
    /// Each profile's part of the change, in the profiles' order: one plan per profile, all their
    /// lenses in the same rounds, and one pool through one dedup and one verification.
    pub tracks: Vec<Track>,
    /// The changed files no profile covers that carry something to review (`coverage::uncovered`).
    /// Optional, so a state written before it reads as before and the format keeps its version.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub uncovered: Vec<String>,
    /// A light pass (`depth=light`) rather than the full review.
    pub light: bool,
    /// The launcher said the run reviews only the fix commits since an earlier review (`--delta`),
    /// as a re-review whose base is that review's commit does: it never approves. Optional, so a
    /// state written before it reads as no delta.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub delta: bool,
    /// The optional lenses the run was asked for, qualified by profile ([`crate::optional`]).
    /// Optional, so a state written before it reads as a run that bought none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub optional: Vec<String>,
    pub phase: Phase,
    /// The current phase's tasks.
    pub tasks: Vec<Task>,
    /// The lens rounds: the pool they filled and their coverage.
    pub rounds: Rounds,
    /// What verification judges: the pool after the floor, the roll-up and the dedup, each a
    /// finding object as its schema shapes it.
    pub findings: Vec<Value>,
    /// The findings as verification settled them, each with its `tier`; empty until it has.
    pub settled: Vec<Value>,
    /// Why the run ended before any lens ran: the coverage exit's verdict and message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit: Option<crate::coverage::Exit>,
    /// What happened on the way, for the report.
    pub notes: Vec<String>,
    /// What did not run that the review needed: any entry makes the verdict INCOMPLETE.
    pub not_run: Vec<String>,
    /// The coverage gaps the review stands without: a metrics-only lens that never returned, or
    /// one that could not look ([`crate::complexity::Look::CouldNotLook`]). Each caps Approve at
    /// Warning, never INCOMPLETE, which stays for what the review itself needed, and is named
    /// whatever the verdict ([`crate::report::capped`]), never in `not_run`. Optional, so a state
    /// written before it reads as a run with none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capped: Vec<String>,
    /// How the run was weaker than asked, as its host said when submitting (`submit_noting`): a task
    /// run without the agent it named, say; or as the lenses' answers show it: a lens that read no
    /// rubric file whole ([`crate::rubric_read`]). The report names each; the verdict stands. Optional, so
    /// a state written before it reads as before and the format keeps its version.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub degraded: Vec<String>,
    /// The skills the tasks of any step so far were told to load that no absolute path was found
    /// for, each once ([`crate::prompts::skills::keep_unresolved`]): a later phase's tasks replace
    /// the lenses that named them, so the report reads them here. Optional, as `degraded`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills_unresolved: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict: Option<String>,
    /// Where the run stands in its branch's chain of review rounds. Optional, so a state written
    /// before it reads as a first review and the format keeps its version.
    #[serde(default)]
    pub chain: Chain,
    /// The project's memory: the records the run applies and what they set aside. Optional, so a
    /// state written before it reads as a run with none.
    #[serde(default)]
    pub memory: Memory,
    /// The mechanical gate before the lenses. Optional, so a state written before it reads as a
    /// run without one.
    #[serde(default)]
    pub gate: Gate,
    /// The completeness critic and the lenses it admitted. Optional, so a state written before it
    /// reads as a run whose critic has not been asked.
    #[serde(default)]
    pub critic: Critic,
    /// The consumer's own agents run as extra lenses. Optional, so a state written before it reads
    /// as a run with them off.
    #[serde(default)]
    pub extra: Extra,
    /// Unit mode. Optional, so a state written before it reads as a run with the mode off.
    #[serde(default)]
    pub units: Units,
    /// The dispatch round being answered and whether any of its tasks answered ([`crate::stop`]).
    /// Optional, so a state written before it reads as a round with no answer yet.
    #[serde(default)]
    pub watch: crate::stop::Watch,
    /// Why the run stopped before its end, its unanswered tasks held for a resume
    /// ([`crate::stop`]); `None`, it did not.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stopped: Option<crate::stop::Stop>,
    /// The findings' publication on the PR and the memory contradictions ([`crate::publish`]).
    /// Optional, so a state written before it reads as a run that posts nothing.
    #[serde(default)]
    pub publish: crate::publish::Publish,
    /// What the record carries of the lenses and the verification ([`crate::telemetry`]).
    /// Optional, so a state written before it reads as a run with nothing counted yet.
    #[serde(default)]
    pub telemetry: crate::telemetry::Tally,
}

impl RunState {
    /// The track of `profile`.
    #[must_use]
    pub fn track(&self, profile: &str) -> Option<&Track> {
        self.tracks.iter().find(|t| t.profile == profile)
    }

    /// The plan of `profile`'s part, once its scout is in.
    #[must_use]
    pub fn plan_of(&self, profile: &str) -> Option<&Plan> {
        self.track(profile).and_then(|t| t.plan.as_ref())
    }
}

/// The profile a pooled finding was found under: its `profile`, else the run's first.
#[must_use]
pub fn finding_profile<'a>(run: &'a RunState, f: &'a Value) -> &'a str {
    f.get("profile")
        .and_then(Value::as_str)
        .or_else(|| run.tracks.first().map(|t| t.profile.as_str()))
        .unwrap_or("")
}

/// The state file of the run in `dir`.
#[must_use]
pub fn state_path(dir: &Path) -> PathBuf {
    dir.join("state.json")
}

/// The report of the run in `dir`.
#[must_use]
pub fn report_path(dir: &Path) -> PathBuf {
    dir.join("report.md")
}

/// Reads the run in `dir`.
///
/// # Errors
/// When there is no state file, it is not JSON of this format, or its version differs.
pub fn load(dir: &Path) -> Result<RunState, StateError> {
    let path = state_path(dir);
    let text = std::fs::read_to_string(&path).map_err(|source| StateError::Unreadable {
        path: path.clone(),
        source,
    })?;
    let state: RunState = serde_json::from_str(&text).map_err(|source| StateError::Malformed {
        path: path.clone(),
        source,
    })?;
    if state.version != STATE_VERSION {
        return Err(StateError::Version {
            path,
            found: state.version,
        });
    }
    Ok(state)
}

/// Whether the state in `dir` was written by a newer craft, in a format past [`STATE_VERSION`]:
/// its telemetry is that craft's to read and write, so this one touches none of it.
#[must_use]
pub fn newer(dir: &Path) -> bool {
    #[derive(Deserialize)]
    struct Only {
        version: u32,
    }
    std::fs::read_to_string(state_path(dir))
        .ok()
        .and_then(|t| serde_json::from_str::<Only>(&t).ok())
        .is_some_and(|o| o.version > STATE_VERSION)
}

/// The phase the state in `dir` records, whatever its format: what the run's telemetry needs to
/// file an earlier binary's run before [`load`] refuses it; `None` when it cannot be read.
#[must_use]
pub fn phase_of(dir: &Path) -> Option<Phase> {
    #[derive(Deserialize)]
    struct Only {
        phase: Phase,
    }
    let text = std::fs::read_to_string(state_path(dir)).ok()?;
    serde_json::from_str::<Only>(&text).ok().map(|o| o.phase)
}

/// Writes the run's state into `dir`, whole or not at all.
///
/// # Errors
/// When the file cannot be written.
pub fn save(dir: &Path, state: &RunState) -> Result<(), StateError> {
    let path = state_path(dir);
    let tmp = dir.join("state.json.tmp");
    let text = format!("{}\n", serde_json::to_string_pretty(state)?);
    std::fs::write(&tmp, text).map_err(|source| StateError::Unwritable {
        path: tmp.clone(),
        source,
    })?;
    std::fs::rename(&tmp, &path).map_err(|source| StateError::Unwritable { path, source })
}

/// Whether a count is zero, so a field that is leaves a state's shape as it was.
#[expect(
    clippy::trivially_copy_pass_by_ref,
    reason = "serde's skip_serializing_if hands a reference"
)]
const fn is_zero(n: &usize) -> bool {
    *n == 0
}
