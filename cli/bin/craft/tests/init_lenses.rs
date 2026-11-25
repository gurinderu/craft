//! `craft init`'s lens composition (realm @nick/craft, node #647): `--propose` counts each lens's
//! yield over the runs the store holds for this repository alone and offers the quiet ones,
//! `--write --lens` records what the reviewer confirmed, replaced on each write and refused whole
//! as a review would refuse it. HOME is a temporary directory holding the store.
#![expect(
    clippy::unwrap_used,
    reason = "the fixture helpers fail the test loudly, like the tests they serve"
)]

use std::path::Path;
use std::process::{Command, Output};

use serde_json::{Value, json};

fn repo(t: &Path) -> String {
    let repo = t.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    let ok = Command::new("git")
        .args(["init", "-q", "-b", "main"])
        .arg(&repo)
        .output()
        .unwrap();
    assert!(ok.status.success());
    // The store's key is the path git reports, symlinks resolved (a temporary directory may be one).
    std::fs::canonicalize(&repo).unwrap().display().to_string()
}

/// `n` finished review records of `project` in the store, each running `lenses`, a lens's confirmed
/// findings as its `bySeverity` says.
fn runs(t: &Path, project: &str, n: usize, lenses: &[(&str, Value)]) {
    let store = t.join("home/.craft/runs");
    std::fs::create_dir_all(&store).unwrap();
    let tag = project.replace('/', "_");
    for i in 0..n {
        let dims: Vec<Value> = lenses
            .iter()
            .map(|(l, by)| json!({"dimension": l, "ran": true, "bySeverity": by}))
            .collect();
        let r = json!({
            "schemaVersion": 1, "kind": "workflow", "name": "review", "driver": "cli",
            "ts": format!("2026-11-01T10-00-{i:02}Z"), "craftVersion": "0.61.0",
            "project": project, "dimensions": dims,
        });
        std::fs::write(store.join(format!("{tag}-{i:03}.json")), r.to_string()).unwrap();
    }
}

fn craft(t: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_craft"))
        .args(args)
        .env("HOME", t.join("home"))
        .env("CRAFT_CODE_GRAPH", "")
        .env_remove("CRAFT_ROOT")
        .output()
        .unwrap()
}

fn json_of(out: &Output) -> Value {
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}

fn lenses(t: &Path, repo: &str) -> Value {
    json_of(&craft(t, &["init", "--propose", "--cwd", repo]))
        .get("lenses")
        .cloned()
        .unwrap()
}

#[test]
fn propose_offers_the_lenses_quiet_on_this_repository_and_counts_no_other() {
    let tmp = tempfile::tempdir().unwrap();
    let t = tmp.path();
    let repo = repo(t);
    let quiet = json!({"Low": 2});
    runs(
        t,
        &repo,
        20,
        &[
            ("rust:money", quiet.clone()),
            ("rust:errors", json!({"Medium": 1})),
            ("rust:safety", json!({})),
        ],
    );
    runs(
        t,
        "/elsewhere/other",
        30,
        &[("rust:maintainability", quiet)],
    );
    let l = lenses(t, &repo);
    assert_eq!(
        l["candidates"],
        json!([{"lens": "rust:money", "runs": 20, "states": ["first-round", "off"]}]),
        "{l}"
    );
    let named: Vec<&str> = l["yield"]
        .as_array()
        .unwrap()
        .iter()
        .map(|y| y["lens"].as_str().unwrap())
        .collect();
    assert_eq!(
        named,
        ["rust:errors", "rust:money", "rust:safety"],
        "another repository's runs are not this one's"
    );
    assert_eq!(l["held"], json!([]));
    assert_eq!(l["passes"], 20);
}

#[test]
fn write_records_the_confirmed_lenses_replaces_them_and_refuses_what_a_review_would() {
    let tmp = tempfile::tempdir().unwrap();
    let t = tmp.path();
    let repo = repo(t);
    let write = |lens: &[&str]| {
        let mut args = vec!["init", "--write", "--cwd", repo.as_str()];
        for l in lens {
            args.extend(["--lens", l]);
        }
        craft(t, &args)
    };
    let first = json_of(&write(&[
        "rust:money=off",
        "general:concurrency=first-round",
    ]));
    assert_eq!(
        first["lenses"],
        json!({"general:concurrency": "first-round", "rust:money": "off"})
    );
    assert_eq!(
        lenses(t, &repo)["held"],
        json!(["general:concurrency=first-round", "rust:money=off"])
    );

    let refused = write(&["rust:money=off", "rust:safety=off"]);
    assert_ne!(refused.status.code(), Some(0));
    assert!(
        String::from_utf8_lossy(&refused.stderr).contains("security lens"),
        "{refused:?}"
    );
    assert_ne!(write(&["rust:money=sometimes"]).status.code(), Some(0));
    let twice = write(&["rust:money=off", "rust:money=first-round"]);
    assert!(
        String::from_utf8_lossy(&twice.stderr).contains("named twice"),
        "{twice:?}"
    );
    assert_eq!(
        lenses(t, &repo)["held"],
        json!(["general:concurrency=first-round", "rust:money=off"]),
        "a refused write leaves the profile as it was"
    );

    json_of(&write(&[]));
    assert_eq!(
        lenses(t, &repo)["held"],
        json!([]),
        "a write naming none replaces them with none"
    );
}

#[test]
fn a_held_state_is_not_offered_again_and_an_unreadable_store_leaves_the_rest_of_propose() {
    let tmp = tempfile::tempdir().unwrap();
    let t = tmp.path();
    let repo = repo(t);
    runs(t, &repo, 20, &[("rust:money", json!({}))]);
    json_of(&craft(
        t,
        &[
            "init",
            "--write",
            "--cwd",
            &repo,
            "--lens",
            "rust:money=off",
        ],
    ));
    assert_eq!(
        lenses(t, &repo)["candidates"],
        json!([{"lens": "rust:money", "runs": 20, "states": ["first-round"]}])
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let store = t.join("home/.craft/runs");
        std::fs::set_permissions(&store, std::fs::Permissions::from_mode(0o000)).unwrap();
        let l = lenses(t, &repo);
        std::fs::set_permissions(&store, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(l["yieldUnread"].is_string(), "{l}");
        assert_eq!(l["held"], json!(["rust:money=off"]));
    }
}
