//! The findings no verifier checked at Low or Info severity, held apart from the report a session
//! reads whole (realm @nick/craft, node #636): written to `unverified.md` beside the report, the
//! report and the finished step naming how many there are and where. An unverified finding at
//! Medium or above is still listed: its check died, it was not skipped.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::settle::Tier;
use crate::state::RunState;
use crate::step::StepError;

/// The file the held findings are written to, in the run directory.
pub const FILE: &str = "unverified.md";

/// Where the run in `dir` keeps its held findings.
#[must_use]
pub fn path(dir: &Path) -> PathBuf {
    dir.join(FILE)
}

/// Whether `f` is held apart: unverified, at Low or Info severity.
#[must_use]
pub fn held(f: &Value) -> bool {
    Tier::of(f) == Tier::Unverified
        && matches!(
            f.get("severity").and_then(Value::as_str),
            Some("Low" | "Info")
        )
}

/// The run's held findings, most severe first.
fn of(state: &RunState) -> Vec<&Value> {
    let mut list: Vec<&Value> = state.settled.iter().filter(|f| held(f)).collect();
    list.sort_by_key(|f| crate::dedup::sev_rank(f));
    list
}

/// The report's line on the held findings, "" when there are none.
pub(super) fn line(state: &RunState) -> String {
    match of(state).len() {
        0 => String::new(),
        n => format!(
            "{n} Low or Info finding(s) no verifier checked are not listed here: they are in `{FILE}` beside this report.\n"
        ),
    }
}

/// What the finished step says of them: their count and file, `None` when there are none.
#[must_use]
pub fn step_field(dir: &Path, state: &RunState) -> Option<Value> {
    let n = of(state).len();
    (n > 0).then(|| json!({"count": n, "file": path(dir).display().to_string()}))
}

/// Writes the held findings beside the report, or removes a file an earlier write left when there
/// are none now.
///
/// # Errors
/// When the file cannot be written.
pub(super) fn write(dir: &Path, state: &RunState) -> Result<(), StepError> {
    let path = path(dir);
    let list = of(state);
    if list.is_empty() {
        drop(std::fs::remove_file(&path));
        return Ok(());
    }
    let mut out = String::from(
        "# Unverified Low and Info findings\n\nNo verifier checked these against the code.\n\n",
    );
    for f in list {
        out.push_str(&super::entry(f));
    }
    std::fs::write(&path, out).map_err(|source| StepError::NoReport { path, source })
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::{held, path, step_field, write};
    use crate::state::RunState;

    fn finding(severity: &str, tier: &str, title: &str) -> Value {
        json!({"severity": severity, "tier": tier, "file": "src/lib.rs", "line": 1, "title": title, "why": "w", "source": "intent"})
    }

    fn run(settled: &[Value]) -> RunState {
        serde_json::from_value(json!({
            "version": crate::state::STATE_VERSION,
            "context": {"repo": "/r", "base": "origin/main", "spec": "", "craftRoot": null, "craftVersion": null},
            "diff": {"base": "origin/main", "mergeBase": "m", "head": "h", "dirty": false, "files": ["src/lib.rs"], "stat": "", "log": ""},
            "tracks": [], "light": false, "phase": "done", "tasks": [],
            "rounds": {"round": 1, "pool": [], "yields": [], "expected": [], "returned": [], "failures": {}},
            "findings": [], "settled": settled, "notes": [], "notRun": []
        }))
        .unwrap()
    }

    #[test]
    fn an_unverified_low_or_info_is_held_and_nothing_else_is() {
        assert!(held(&finding("Low", "unverified", "a")));
        assert!(held(&finding("Info", "unverified", "a")));
        assert!(!held(&finding("Medium", "unverified", "a")));
        assert!(!held(&finding("Low", "confirmed", "a")));
        assert!(!held(&finding("Info", "refuted", "a")));
    }

    #[test]
    fn the_held_file_lists_them_worst_first_and_a_rewrite_holding_none_removes_it() {
        let dir = tempfile::tempdir().unwrap();
        let first = run(&[
            finding("Info", "unverified", "nit"),
            finding("Low", "unverified", "naming"),
            finding("High", "confirmed", "bug"),
        ]);
        write(dir.path(), &first).unwrap();
        let text = std::fs::read_to_string(path(dir.path())).unwrap();
        let (low, info) = (text.find("naming").unwrap(), text.find("nit").unwrap());
        assert!(low < info && !text.contains("bug"), "{text}");
        assert_eq!(step_field(dir.path(), &first).unwrap()["count"], json!(2));
        let none = run(&[finding("High", "confirmed", "bug")]);
        write(dir.path(), &none).unwrap();
        assert!(
            !path(dir.path()).exists(),
            "a rewrite holding none leaves no stale file"
        );
        assert!(step_field(dir.path(), &none).is_none());
    }
}
