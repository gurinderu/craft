//! The files an entry's coverage rests on (realm @nick/craft, node #482): the workflow, the recipes
//! and local actions the session names, the cargo config; the held form kept as recorded.

use super::CiEntry;

const WF: &str = ".github/workflows/ci.yml";

fn top(workflow: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join(".github/workflows")).unwrap();
    std::fs::write(dir.path().join(WF), workflow).unwrap();
    std::fs::write(
        dir.path().join("justfile"),
        "lint:\n    cargo clippy -- -D warnings\n",
    )
    .unwrap();
    dir
}

fn lint(sources: &str) -> String {
    format!(
        r#"{{"check":"lint","signal":"clippy","command":"cargo clippy -- -D warnings","workflow":"{WF}","sources":{sources}}}"#
    )
}

#[test]
fn a_recipe_edit_marks_the_entry_stale() {
    let t = top("jobs:\n  lint:\n    steps:\n      - run: just lint\n");
    let e = CiEntry::confirmed(&lint(r#"["justfile"]"#), t.path()).unwrap();
    assert!(
        e.hashes.contains_key("justfile") && e.hashes.contains_key(WF),
        "{e:?}"
    );
    assert!(e.fresh(t.path()));
    std::fs::write(t.path().join("justfile"), "lint:\n    cargo clippy\n").unwrap();
    assert_eq!(e.changed(t.path()), vec!["justfile".to_owned()]);
    assert!(!e.fresh(t.path()));
}

#[test]
fn the_cargo_config_is_always_hashed_and_one_appearing_later_marks_it_stale() {
    let t = top("jobs:\n  lint:\n    steps:\n      - run: cargo lint\n");
    let e = CiEntry::confirmed(&lint("[]"), t.path()).unwrap();
    assert!(e.fresh(t.path()));
    std::fs::create_dir_all(t.path().join(".cargo")).unwrap();
    std::fs::write(
        t.path().join(".cargo/config.toml"),
        "[alias]\nlint = \"check\"\n",
    )
    .unwrap();
    assert_eq!(e.changed(t.path()), vec![".cargo/config.toml".to_owned()]);
    let again = CiEntry::confirmed(&lint("[]"), t.path()).unwrap();
    assert!(again.hashes.contains_key(".cargo/config.toml"), "{again:?}");
    std::fs::write(t.path().join(".cargo/config.toml"), "[alias]\n").unwrap();
    assert!(!again.fresh(t.path()));
}

#[test]
fn a_local_action_the_entry_does_not_list_is_refused() {
    let t = top(
        "jobs:\n  lint:\n    steps:\n      - uses: ./.github/actions/lint\n      - uses: actions/checkout@v4\n",
    );
    let action = t.path().join(".github/actions/lint");
    std::fs::create_dir_all(&action).unwrap();
    std::fs::write(action.join("action.yml"), "runs:\n  using: composite\n").unwrap();
    let err = CiEntry::confirmed(&lint("[]"), t.path())
        .unwrap_err()
        .to_string();
    assert!(err.contains("./.github/actions/lint"), "{err}");
    let e = CiEntry::confirmed(&lint(r#"[".github/actions/lint/action.yml"]"#), t.path()).unwrap();
    assert!(e.hashes.contains_key(".github/actions/lint/action.yml"));
}

#[test]
fn the_held_form_is_kept_with_its_hashes_so_a_stale_entry_stays_stale() {
    let t = top("jobs:\n  lint:\n    steps:\n      - run: just lint\n");
    let e = CiEntry::confirmed(&lint(r#"["justfile"]"#), t.path()).unwrap();
    std::fs::write(t.path().join("justfile"), "lint:\n    cargo clippy\n").unwrap();
    let held = serde_json::to_string(&e).unwrap();
    let back = CiEntry::confirmed(&held, t.path()).unwrap();
    assert_eq!(back, e, "kept as given");
    assert!(!back.fresh(t.path()), "still stale");
}

#[test]
fn a_held_form_whose_hashes_miss_a_source_is_refused() {
    let t = top("jobs:\n  lint:\n    steps:\n      - run: just lint\n");
    let e = CiEntry::confirmed(&lint("[]"), t.path()).unwrap();
    let mut v = serde_json::to_value(&e).unwrap();
    v["sources"] = serde_json::json!(["justfile"]);
    let err = CiEntry::confirmed(&v.to_string(), t.path())
        .unwrap_err()
        .to_string();
    assert!(err.contains("justfile") && err.contains("hash"), "{err}");
    let mut v = serde_json::to_value(&e).unwrap();
    v["workflow_hash"] = "x".into();
    CiEntry::confirmed(&v.to_string(), t.path()).unwrap_err();
}
