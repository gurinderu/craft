//! The mechanical gate alone (`craft review gate`): the gate a review start runs, over the whole
//! change, with no run, no lens and no record (realm @nick/craft, node #472). rust-audit runs it
//! once for the workspace before its per-crate reviews and before its own dimensions that build
//! with cargo (realm @nick/craft, node #150), so clippy builds the workspace once and alone, rather
//! than once per crate, or beside another build holding cargo's lock until the gate's budget is
//! gone. The result — the gate and its seeds, as a start keeps its own — is written into the
//! directory, and each per-crate run takes it (`review start --gate-from`, [`taken`]): the seeds on
//! that run's files reach its lenses.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{Gate, GateSetup, Status};
use crate::Error;
use crate::git;
use crate::profile::Profile;
use crate::step::StepError;

/// The file in the gate's directory that holds its result.
pub const RESULT_FILE: &str = "gate-result.json";

/// The gate's result as `craft review gate` writes it and `--gate-from` reads it: the change it
/// gated — the commit `HEAD` named and the merge-base with the base — the gate, and its seeds.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Kept {
    pub head: String,
    pub merge_base: String,
    pub gate: Gate,
    pub seeds: Vec<Value>,
}

/// How the gate came out as a whole: `fail` when a profile's gate is red, else `unknown` when one
/// could not be established, else `pass`; `none` when no profile of the change has a gate.
#[must_use]
pub fn outcome(gate: &Gate) -> &'static str {
    if gate.tracks.is_empty() {
        "none"
    } else if gate.exit().is_some() {
        "fail"
    } else if gate.tracks.iter().any(|t| t.status == Status::Unknown) {
        "unknown"
    } else {
        "pass"
    }
}

/// Runs the gate over the change in `cwd` against `base` (the merge-base with origin's default
/// branch when `None`), the tools' output and the result ([`RESULT_FILE`]) kept under `dir`, and
/// returns it as one JSON value: the base and head it read, its `outcome`, the red gate's verdict
/// line as a review words it, or why an unknown one is not established ([`super::unknown`]; `''`
/// when it passed), the report's gate section, the gate itself and the directory a run takes it
/// from.
///
/// # Errors
/// When the repository or base cannot be read, the profiles cannot be loaded, or `dir` cannot be
/// created or the result written.
pub fn alone(
    cwd: &Path,
    base: Option<&str>,
    dir: &Path,
    setup: &GateSetup,
) -> Result<Value, Error> {
    let cwd = cwd.canonicalize().map_err(|source| StepError::NoRepo {
        path: cwd.to_owned(),
        source,
    })?;
    let diff = git::read_diff(&cwd, base, None)?;
    let no_dir = |source| StepError::NoDir {
        path: dir.to_owned(),
        source,
    };
    std::fs::create_dir_all(dir).map_err(no_dir)?;
    let profiles = Profile::all()?;
    let (tracks, _) = crate::step::tracks_of(&diff.files, &profiles);
    let (gate, seeds) = super::run(&cwd, &diff.base, &tracks, setup, dir);
    let kept = Kept {
        head: diff.head.clone(),
        merge_base: diff.merge_base.clone(),
        gate: gate.clone(),
        seeds,
    };
    let text = serde_json::to_string(&kept).unwrap_or_default();
    std::fs::write(dir.join(RESULT_FILE), text).map_err(no_dir)?;
    // An unknown gate's line names why and the CI it saw (realm @nick/craft, node #487).
    let line = gate
        .exit()
        .map(|e| e.line)
        .or_else(|| super::unknown::reason(&gate))
        .unwrap_or_default();
    Ok(json!({
        "base": diff.base,
        "head": diff.head,
        "outcome": outcome(&gate),
        "line": line,
        "section": super::section(&gate),
        "gate": gate,
        "dir": dir.display().to_string(),
    }))
}

/// The gate a run takes from the launching run's directory `dir` rather than running its own: the
/// gate as it came out, marked as taken from there, and its seeds on the run's own changed files. A
/// result that cannot be read, or that gated another change — another `HEAD` or merge-base than
/// the run's `diff` — is no gate for this run: it is taken as none, its section saying why, and
/// the review goes on as one without a gate (a stale red gate must not block, nor a stale green
/// one stand for this change).
#[must_use]
pub fn taken(dir: &Path, diff: &git::Diff) -> (Gate, Vec<Value>) {
    let shown = dir.display();
    let unusable = |why: String| Gate {
        skipped: format!("the launching run's gate in `{shown}` was not used: {why}"),
        ..Gate::default()
    };
    let kept = match std::fs::read_to_string(dir.join(RESULT_FILE))
        .map_err(|e| e.to_string())
        .and_then(|t| serde_json::from_str::<Kept>(&t).map_err(|e| e.to_string()))
    {
        Ok(k) => k,
        Err(e) => {
            return (
                unusable(format!("its result cannot be read ({e})")),
                Vec::new(),
            );
        }
    };
    if kept.head != diff.head || kept.merge_base != diff.merge_base {
        let why = format!(
            "it gated HEAD {} over merge-base {}, this run reviews HEAD {} over {}",
            kept.head, kept.merge_base, diff.head, diff.merge_base
        );
        return (unusable(why), Vec::new());
    }
    let mine = |s: &Value| {
        s.get("file")
            .and_then(Value::as_str)
            .is_some_and(|f| diff.files.iter().any(|x| x == f))
    };
    let seeds = kept.seeds.into_iter().filter(mine).collect();
    let gate = Gate {
        from: shown.to_string(),
        ..kept.gate
    };
    (gate, seeds)
}
