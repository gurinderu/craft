//! What an entry's command is found in (realm @nick/craft, node #482): a `run:` line of its job or
//! a listed source; a held entry is checked the same while its files are the ones it was hashed
//! from, and an entry no longer found is not fresh.

use super::CiEntry;

const WF: &str = ".github/workflows/ci.yml";

fn top(workflow: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join(".github/workflows")).unwrap();
    std::fs::write(dir.path().join(WF), workflow).unwrap();
    std::fs::write(
        dir.path().join("justfile"),
        "lint:\n    cargo clippy  -- -D \\\n      warnings\n",
    )
    .unwrap();
    dir
}

fn lint(check: &str, command: &str, sources: &str) -> String {
    format!(
        r#"{{"check":"{check}","signal":"clippy","command":"{command}","workflow":"{WF}","sources":{sources}}}"#
    )
}

const TWO_JOBS: &str = "jobs:\n  lint:\n    steps:\n      - run: just lint\n  other:\n    steps:\n      - run: |\n          cargo   clippy --all-targets \\\n            -- -D warnings\n";

#[test]
fn a_command_in_neither_the_job_nor_a_source_is_refused_naming_where_it_was_sought() {
    let t = top(TWO_JOBS);
    let err = CiEntry::confirmed(&lint("lint", "cargo clippy -- -D warnings", "[]"), t.path())
        .unwrap_err()
        .to_string();
    assert!(
        err.contains("not found") && err.contains(WF) && err.contains("sources"),
        "{err}"
    );
    let other = "cargo clippy --all-targets -- -D warnings";
    CiEntry::confirmed(&lint("lint", other, "[]"), t.path()).unwrap_err();
    let e = CiEntry::confirmed(&lint("other", other, "[]"), t.path()).unwrap();
    assert!(e.fresh(t.path()), "found in its own job, whitespace aside");
    let e = CiEntry::confirmed(
        &lint("lint", "cargo clippy -- -D warnings", r#"["justfile"]"#),
        t.path(),
    )
    .unwrap();
    assert!(
        e.fresh(t.path()),
        "found in the listed recipe, its continuation joined"
    );
}

#[test]
fn a_held_entry_whose_command_or_check_was_edited_is_checked_again() {
    let t = top(TWO_JOBS);
    let e = CiEntry::confirmed(
        &lint("lint", "cargo clippy -- -D warnings", r#"["justfile"]"#),
        t.path(),
    )
    .unwrap();
    let mut v = serde_json::to_value(&e).unwrap();
    v["command"] = "cargo clippy --all-targets -- -D warnings".into();
    CiEntry::confirmed(&v.to_string(), t.path()).unwrap_err();
    let mut v = serde_json::to_value(&e).unwrap();
    v["sources"] = serde_json::json!([]);
    v["hashes"].as_object_mut().unwrap().remove("justfile");
    let err = CiEntry::confirmed(&v.to_string(), t.path())
        .unwrap_err()
        .to_string();
    assert!(err.contains("not found"), "{err}");
}

#[test]
fn a_held_entry_is_refused_a_local_action_it_does_not_list() {
    let t = top("jobs:\n  lint:\n    steps:\n      - run: cargo clippy -- -D warnings\n");
    let e =
        CiEntry::confirmed(&lint("lint", "cargo clippy -- -D warnings", "[]"), t.path()).unwrap();
    let wf = "jobs:\n  lint:\n    steps:\n      - uses: ./act\n      - run: cargo clippy -- -D warnings\n";
    std::fs::write(t.path().join(WF), wf).unwrap();
    let mut v = serde_json::to_value(&e).unwrap();
    v["hashes"][WF] = super::ci_files::hash(t.path(), WF).unwrap().into();
    let err = CiEntry::confirmed(&v.to_string(), t.path())
        .unwrap_err()
        .to_string();
    assert!(err.contains("./act"), "{err}");
}

#[test]
fn a_stale_held_entry_is_kept_and_one_no_longer_found_is_not_fresh() {
    let t = top(TWO_JOBS);
    let e = CiEntry::confirmed(
        &lint("lint", "cargo clippy -- -D warnings", r#"["justfile"]"#),
        t.path(),
    )
    .unwrap();
    std::fs::write(t.path().join("justfile"), "lint:\n    true\n").unwrap();
    let back = CiEntry::confirmed(&serde_json::to_string(&e).unwrap(), t.path()).unwrap();
    assert!(!back.fresh(t.path()), "stale, kept as given");
    let mut edited = e;
    edited.command = "cargo clippy --all-targets -- -D warnings".into();
    std::fs::write(
        t.path().join("justfile"),
        "lint:\n    cargo clippy -- -D warnings\n",
    )
    .unwrap();
    let e = CiEntry::confirmed(
        &lint("lint", "cargo clippy -- -D warnings", r#"["justfile"]"#),
        t.path(),
    )
    .unwrap();
    edited.hashes = e.hashes;
    assert!(
        edited.changed(t.path()).is_empty(),
        "its files are the hashed ones"
    );
    assert!(
        !edited.fresh(t.path()),
        "but its command is not found in them"
    );
}
