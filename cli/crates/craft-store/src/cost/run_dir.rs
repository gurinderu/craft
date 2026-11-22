//! Where a Workflow run's per-agent transcripts live: the harness writes them to
//! `<claudeHome>/projects/<slug>/<session>/subagents/workflows/<runId>/` (realm @nick/craft, node #393).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// The entries of `dir` by name, sorted; none when it cannot be listed.
pub(crate) fn entries(dir: &Path) -> Vec<String> {
    let mut out: Vec<String> = std::fs::read_dir(dir)
        .map(|r| {
            r.flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

/// Whether `name` is a transcript of an agent (`agent-*.jsonl`).
pub(super) fn is_transcript(name: &str) -> bool {
    name.starts_with("agent-") && name.ends_with(".jsonl") && name.len() >= "agent-.jsonl".len()
}

/// The transcripts under `run_dir`, sorted.
///
/// # Errors
/// When the directory cannot be listed.
pub(super) fn transcripts(run_dir: &Path) -> Result<Vec<String>, String> {
    let read = std::fs::read_dir(run_dir)
        .map_err(|e| format!("run directory not readable: {} ({e})", run_dir.display()))?;
    let mut names: Vec<String> = read
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| is_transcript(n))
        .collect();
    names.sort();
    Ok(names)
}

fn valid_run_id(id: &str) -> bool {
    id.strip_prefix("wf_").is_some_and(|rest| {
        !rest.is_empty()
            && rest
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    })
}

/// The run's transcript directory. A resumed session links the run's directory under its own
/// session too, so one directory reached by two paths is one; of two real directories the one
/// holding all the others' agents is the run; otherwise, or with none, the run is refused by name.
///
/// # Errors
/// On a malformed run id, no directory, or several of which none holds the others' agents.
pub fn find_run_dir(run_id: &str, claude_home: &Path) -> Result<PathBuf, String> {
    if !valid_run_id(run_id) {
        return Err(format!("not a Workflow run id: {run_id}"));
    }
    let projects = claude_home.join("projects");
    let mut found = BTreeSet::new();
    for slug in entries(&projects) {
        for session in entries(&projects.join(&slug)) {
            let dir = projects
                .join(&slug)
                .join(session)
                .join("subagents/workflows")
                .join(run_id);
            if let Ok(real) = std::fs::canonicalize(&dir)
                && real.is_dir()
            {
                found.insert(real);
            }
        }
    }
    let found: Vec<PathBuf> = found.into_iter().collect();
    if found.is_empty() {
        return Err(format!(
            "no transcript directory for run {run_id} under {}",
            projects.display()
        ));
    }
    holding_all(&found).ok_or_else(|| {
        let all: Vec<String> = found.iter().map(|d| d.display().to_string()).collect();
        format!(
            "run {run_id} has {} transcript directories and none holds the others' agents, refusing to pick one: {}",
            found.len(),
            all.join(", ")
        )
    })
}

/// The one directory holding every agent transcript the others hold. Observed (2026-10-29): a
/// session that resumed a run copied its directory and went on adding to the copy.
fn holding_all(dirs: &[PathBuf]) -> Option<PathBuf> {
    let names: Vec<BTreeSet<String>> = dirs
        .iter()
        .map(|d| {
            entries(d)
                .into_iter()
                .filter(|n| is_transcript(n))
                .collect()
        })
        .collect();
    let i = names
        .iter()
        .position(|mine| names.iter().all(|other| other.is_subset(mine)))?;
    dirs.get(i).cloned()
}
