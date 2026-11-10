//! Whether a held CI map entry can be kept (realm @nick/craft, node #482): `unusable` names the
//! gate's reason to skip it, else the refusal `--write` gives it passed back as `ci` prints it.

use super::CiEntry;

const WF: &str = ".github/workflows/ci.yml";
const OTHER: &str = ".github/workflows/other.yml";
const CLIPPY: &str =
    "jobs:\n  clippy:\n    steps:\n      - run: cargo clippy --all-targets -- -D warnings\n";
const SIBLING: &str =
    "jobs:\n  docs:\n    name: clippy (docs)\n    steps:\n      - run: mdbook build\n";

fn top() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join(".github/workflows")).unwrap();
    std::fs::write(dir.path().join(WF), CLIPPY).unwrap();
    dir
}

fn clippy(top: &std::path::Path) -> CiEntry {
    CiEntry::confirmed(
        r#"{"check":"clippy","signal":"clippy","command":"cargo clippy --all-targets -- -D warnings","workflow":".github/workflows/ci.yml"}"#,
        top,
    )
    .unwrap()
}

/// What `--write` does with `e` passed back as `ci` prints it.
fn written(e: &CiEntry, top: &std::path::Path) -> Result<CiEntry, String> {
    let held = serde_json::to_string(e).map_err(|e| e.to_string())?;
    CiEntry::confirmed(&held, top).map_err(|e| e.to_string())
}

fn why(e: &CiEntry, top: &std::path::Path) -> Option<String> {
    e.unusable(top).map(|r| r.to_string())
}

#[test]
fn a_held_entry_its_write_refuses_is_unusable_with_the_write_s_reason() {
    let t = top();
    let e = clippy(t.path());
    assert_eq!(why(&e, t.path()), None, "written fine");
    std::fs::write(t.path().join(OTHER), SIBLING).unwrap();
    let write = written(&e, t.path()).unwrap_err();
    assert_eq!(why(&e, t.path()), Some(write));
    let expr = CiEntry {
        check: "clippy (${{ matrix.arch }})".into(),
        ..e
    };
    let write = written(&expr, t.path()).unwrap_err();
    assert!(write.contains("unexpanded"), "{write}");
    assert_eq!(why(&expr, t.path()), Some(write));
}

#[test]
fn a_check_naming_one_expanded_run_is_unusable_as_its_write_refuses_it() {
    let t = top();
    let wf = "jobs:\n  clippy:\n    name: clippy (${{ matrix.arch }})\n    strategy:\n      matrix:\n        arch: [amd64, arm64]\n    steps:\n      - run: cargo clippy --all-targets -- -D warnings\n";
    std::fs::write(t.path().join(WF), wf).unwrap();
    let e = CiEntry::confirmed(
        r#"{"check":"clippy","signal":"clippy","command":"cargo clippy --all-targets -- -D warnings","workflow":".github/workflows/ci.yml"}"#,
        t.path(),
    )
    .unwrap();
    let one = CiEntry {
        check: "clippy (amd64)".into(),
        ..e
    };
    let write = written(&one, t.path()).unwrap_err();
    assert!(write.contains("one expanded run"), "{write}");
    assert_eq!(why(&one, t.path()), Some(write));
}

#[test]
fn a_stale_entry_is_kept_unless_the_gate_skips_it_for_a_sibling() {
    let t = top();
    let e = clippy(t.path());
    std::fs::write(t.path().join(WF), format!("{CLIPPY}  more:\n")).unwrap();
    assert!(!e.fresh(t.path()), "stale");
    assert_eq!(why(&e, t.path()), None, "kept stale, confirmed again later");
    assert_eq!(written(&e, t.path()), Ok(e.clone()));
    std::fs::write(t.path().join(OTHER), SIBLING).unwrap();
    assert_eq!(written(&e, t.path()), Ok(e.clone()), "the write keeps it");
    let gate = e.unmatched(t.path()).unwrap().to_string();
    assert!(gate.contains("\"clippy (docs)\""), "{gate}");
    assert_eq!(why(&e, t.path()), Some(gate), "the gate's skip, named");
}
