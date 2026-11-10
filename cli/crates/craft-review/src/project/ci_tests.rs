use super::{CiEntry, ProjectProfile, Signal, load, save};

const WF: &str = ".github/workflows/ci.yml";

/// A repository top holding a workflow file.
fn top() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join(".github/workflows")).unwrap();
    std::fs::write(
        dir.path().join(WF),
        "jobs:\n  clippy:\n    steps:\n      - run: cargo clippy --all-targets -- -D warnings\n",
    )
    .unwrap();
    dir
}

fn clippy(top: &std::path::Path) -> CiEntry {
    CiEntry::confirmed(
        r#"{"check":"clippy","signal":"clippy","command":"cargo clippy --all-targets -- -D warnings","workflow":".github/workflows/ci.yml"}"#,
        top,
    )
    .unwrap()
}

#[test]
fn a_confirmed_entry_carries_the_hash_of_its_workflow_read_now() {
    let t = top();
    let e = clippy(t.path());
    assert_eq!((e.check.as_str(), e.signal), ("clippy", Signal::Clippy));
    assert_eq!(e.hashes[WF].len(), 64);
    assert!(e.fresh(t.path()));
    std::fs::write(t.path().join(WF), "jobs:\n  lint:\n").unwrap();
    assert!(!e.fresh(t.path()), "the workflow changed since");
}

#[test]
fn a_bare_check_name_a_missing_workflow_or_a_path_outside_is_refused() {
    let t = top();
    for (bad, why) in [
        (
            r#"{"check":"clippy","signal":"clippy","command":"clippy","workflow":".github/workflows/ci.yml"}"#,
            "does not run `cargo clippy`",
        ),
        (
            r#"{"check":"tests","signal":"test","command":"cargo clippy","workflow":".github/workflows/ci.yml"}"#,
            "does not run `cargo test`",
        ),
        (
            r#"{"check":"t","signal":"test","command":"cargo test","workflow":".github/workflows/gone.yml"}"#,
            "cannot be read",
        ),
        (
            r#"{"check":"t","signal":"test","command":"cargo test","workflow":"../ci.yml"}"#,
            "inside the repository",
        ),
        (
            r#"{"check":"t","signal":"lint","command":"cargo test","workflow":"ci.yml"}"#,
            "is not",
        ),
        (
            r#"{"check":"","signal":"test","command":"cargo test","workflow":".github/workflows/ci.yml"}"#,
            "one non-empty line",
        ),
    ] {
        let err = CiEntry::confirmed(bad, t.path()).unwrap_err().to_string();
        assert!(err.contains(why), "{bad}: {err}");
    }
}

#[test]
fn the_ci_map_round_trips_is_replaced_by_a_write_and_keeps_unknown_sections() {
    let t = top();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("review.toml");
    let p = ProjectProfile::new("/r/.git".into(), Vec::new(), vec![clippy(t.path())]).unwrap();
    save(&path, &p).unwrap();
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(
        text.contains("[[ci]]") && text.contains("signal = \"clippy\""),
        "{text}"
    );
    assert_eq!(load(&path).unwrap(), Some(p));
    std::fs::write(&path, format!("{text}\n[lenses]\nskip = [\"compat\"]\n")).unwrap();
    save(
        &path,
        &ProjectProfile::new("/r/.git".into(), Vec::new(), Vec::new()).unwrap(),
    )
    .unwrap();
    let held = load(&path).unwrap().unwrap();
    assert!(held.ci.is_empty(), "replaced");
    assert!(std::fs::read_to_string(&path).unwrap().contains("[lenses]"));
}

#[test]
fn one_checks_signal_twice_is_refused() {
    let t = top();
    let e = clippy(t.path());
    ProjectProfile::new(String::new(), Vec::new(), vec![e.clone(), e]).unwrap_err();
}

#[test]
fn a_held_entry_is_refused_as_its_write_would_refuse_it() {
    let t = top();
    let e = clippy(t.path());
    assert!(e.refusal(t.path()).is_none(), "written fine");
    let other = ".github/workflows/other.yml";
    let sibling =
        "jobs:\n  docs:\n    name: clippy (docs)\n    steps:\n      - run: mdbook build\n";
    std::fs::write(t.path().join(other), sibling).unwrap();
    let held = serde_json::to_string(&e).unwrap();
    let write = CiEntry::confirmed(&held, t.path()).unwrap_err().to_string();
    assert_eq!(e.refusal(t.path()).map(|r| r.to_string()), Some(write));
    let expr = CiEntry {
        check: "clippy (${{ matrix.arch }})".into(),
        ..e
    };
    let why = expr.refusal(t.path()).unwrap().to_string();
    assert!(why.contains("unexpanded"), "{why}");
}
