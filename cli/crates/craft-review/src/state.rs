//! A run's state between steps, kept in `state.json` in its run directory: the change, the
//! current phase, the tasks the host is to run, and what their answers said.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::agent::{AgentKind, Model};
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

/// The state file's format; a run written by another format is refused, not misread.
pub const STATE_VERSION: u32 = 6;
/// How many times an invalid or missing answer is asked for again before its task fails.
pub const MAX_RETRIES: u32 = 2;

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
    #[error("the run state {} is format {found}, this craft reads {STATE_VERSION}", path.display())]
    Version { path: PathBuf, found: u32 },
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
    /// The recall of the project's memory; `cut` changed paths past its prompt's bound.
    Recall {
        cut: usize,
    },
    /// The red team attacking the fix of the prior round's finding `prior`, adjudicated resolved.
    RedTeam {
        prior: usize,
    },
    /// The memory's match judge.
    MatchJudge,
    /// The memory's rule judge.
    RuleJudge,
    /// The warm-up finding whether a code-metrics index covers the repository, beside the scouts.
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

/// Whether a task still waits for its answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskState {
    Pending,
    Answered,
    /// Its retries are spent without a valid answer.
    Failed,
}

/// One agent the host is to run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub label: String,
    pub prompt: String,
    pub model: Model,
    pub schema: Value,
    /// The agent it runs on; `None`, the host's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<AgentKind>,
    /// The consumer repository's own agent it runs on, by the name that repository gives it: an
    /// extra lens (realm @nick/craft, node #295). The host runs it on that agent and no other.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub consumer_agent: Option<String>,
    #[serde(flatten)]
    pub kind: TaskKind,
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
}

impl Task {
    #[must_use]
    pub fn new(
        id: String,
        label: String,
        prompt: String,
        model: Model,
        schema: Value,
        kind: TaskKind,
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
            state: TaskState::Pending,
            retries: 0,
            error: None,
            answer: None,
            refused: None,
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
}

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
    /// Its last round added nothing new.
    #[serde(default)]
    pub dry: bool,
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
        }
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
    /// How the run was weaker than asked, as its host said when submitting (`submit_noting`): a task
    /// run without the agent it named, say. The report names each; the verdict stands. Optional, so
    /// a state written before it reads as before and the format keeps its version.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub degraded: Vec<String>,
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
