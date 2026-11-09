//! The world the gate's CI tests run in (realm @nick/craft, node #482): a package whose build is
//! impossible — a cargo that ends with no compiler error —, a stand-in `gh` answering the head's
//! check runs and statuses from files, and the reviewer's profile under a temporary projects
//! directory.

use std::path::Path;
use std::time::Duration;

use super::tests::{package, tool};
use super::{GateSetup, Track as GateTrack, run};
use crate::project::{self, CiEntry, ProjectProfile};
use crate::state::Track;

pub(super) const WF: &str = ".github/workflows/ci.yml";

/// The workflow the world's CI map entries are found in.
const MAPPED: &str = "jobs:\n  clippy:\n    steps:\n      - run: cargo clippy --all-targets -- -D warnings\n      - run: cargo test --locked\n      - run: cargo fmt --check\n";

/// A cargo whose build is impossible: a registry without a token, no compiler message.
pub(super) const UNBUILT: &str = r#"echo "$*" >> "${0%/*}/cargo-calls"
echo 'error: failed to get `x` as a dependency' >&2; echo 'Caused by:' >&2; echo '  no token found for `fluence`' >&2; exit 101"#;

/// A stand-in gh: check runs from `runs.json`, statuses from `status.json`, each call logged;
/// every call fails while `fail` exists. Builtins only: the gate's PATH holds the stand-ins alone.
pub(super) const GH: &str = r#"D="${0%/*}"; echo "$*" >> "$D/gh-calls"
if [ -f "$D/fail" ]; then echo "gh: HTTP 401: Bad credentials" >&2; exit 1; fi
case "$*" in
  *check-runs*) read -r x < "$D/runs.json"; printf '%s\n' "$x" ;;
  */status*) read -r x < "$D/status.json"; printf '%s\n' "$x" ;;
  *) exit 2 ;;
esac"#;

pub(super) struct World {
    pub(super) repo: tempfile::TempDir,
    pub(super) tools: tempfile::TempDir,
    pub(super) projects: tempfile::TempDir,
}

pub(super) fn entry(top: &Path, check: &str, signal: &str, command: &str) -> CiEntry {
    let json =
        serde_json::json!({"check": check, "signal": signal, "command": command, "workflow": WF});
    CiEntry::confirmed(&json.to_string(), top).unwrap()
}

/// A package whose build is impossible, its CI map naming `clippy`, `tests` and the status `fmt`;
/// `runs` the head's check runs, `statuses` its commit statuses.
pub(super) fn world(runs: &str, statuses: &str) -> World {
    let repo = package(None);
    let top = repo.path();
    std::fs::create_dir_all(top.join(".github/workflows")).unwrap();
    std::fs::write(top.join(WF), MAPPED).unwrap();
    let (tools, projects) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    tool(tools.path(), "cargo", UNBUILT);
    tool(tools.path(), "gh", GH);
    std::fs::write(tools.path().join("runs.json"), runs).unwrap();
    std::fs::write(tools.path().join("status.json"), statuses).unwrap();
    let ci = vec![
        entry(
            top,
            "clippy",
            "clippy",
            "cargo clippy --all-targets -- -D warnings",
        ),
        entry(top, "tests", "test", "cargo test --locked"),
        entry(top, "fmt", "fmt", "cargo fmt --check"),
    ];
    save(projects.path(), top, ci);
    World {
        repo,
        tools,
        projects,
    }
}

pub(super) fn save(projects: &Path, top: &Path, ci: Vec<CiEntry>) {
    let (path, common) = project::profile_path(projects, top).unwrap();
    project::save(&path, &ProjectProfile::new(common, Vec::new(), ci).unwrap()).unwrap();
}

pub(super) fn gated(w: &World) -> (super::Gate, GateTrack) {
    let setup = GateSetup {
        budget: Duration::from_secs(30),
        path: Some(w.tools.path().as_os_str().to_owned()),
        scope: None,
        projects: Some(w.projects.path().to_owned()),
    };
    let run_dir = tempfile::tempdir().unwrap();
    let (gate, _) = run(
        w.repo.path(),
        "HEAD~1",
        &[Track::new("rust", vec!["src/lib.rs".into()])],
        &setup,
        run_dir.path(),
    );
    let t = gate.tracks[0].clone();
    (gate, t)
}

pub(super) fn short(w: &World) -> String {
    let head = crate::git::git(w.repo.path(), &["rev-parse", "HEAD"]).unwrap();
    head.trim().chars().take(7).collect()
}

pub(super) fn calls(w: &World, tool: &str) -> String {
    std::fs::read_to_string(w.tools.path().join(format!("{tool}-calls"))).unwrap_or_default()
}

/// The head's check runs, all of one check suite, ids in their order.
pub(super) fn runs(list: &[(&str, &str, &str)]) -> String {
    let one: Vec<_> = list.iter().map(|(n, s, c)| (*n, *s, *c, 1)).collect();
    suited(&one)
}

/// The head's check runs, each with its check suite's id, run ids in their order.
pub(super) fn suited(list: &[(&str, &str, &str, u64)]) -> String {
    let runs: Vec<_> = list
        .iter()
        .enumerate()
        .map(|(i, (name, status, conclusion, suite))| serde_json::json!({"id": i + 1, "name": name, "status": status, "conclusion": conclusion, "check_suite": {"id": suite}}))
        .collect();
    serde_json::json!({"total_count": runs.len(), "check_runs": runs}).to_string()
}

pub(super) const FMT_GREEN: &str =
    r#"{"state":"success","total_count":1,"statuses":[{"context":"fmt","state":"success"}]}"#;
