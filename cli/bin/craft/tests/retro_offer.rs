//! The session start offers a retro once this repository's review runs of this craft version call
//! for one, and `craft runs retro-done` files the mark it counts anew from (realm @nick/craft,
//! node #658). HOME is a temporary directory.
#![expect(
    clippy::unwrap_used,
    reason = "the fixture fails the test loudly, like the tests it serves"
)]

use std::io::Write;
use std::path::Path;
use std::process::{Command, Output, Stdio};

fn craft(home: &Path, cwd: &Path, args: &[&str], stdin: &str) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_craft"))
        .args(args)
        .current_dir(cwd)
        .env("HOME", home)
        .env_remove("CRAFT_RETRO_HOOK")
        .env_remove("CRAFT_ROLE_HOOK")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stdin.as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}

fn start(home: &Path, repo: &Path) -> String {
    let input = serde_json::json!({"cwd": repo, "session_id": "s1", "source": "startup"});
    let out = craft(home, repo, &["hook", "session-start"], &input.to_string());
    assert!(out.status.success(), "{out:?}");
    String::from_utf8(out.stdout).unwrap()
}

#[test]
fn twenty_review_runs_are_offered_a_retro_and_retro_done_counts_them_anew() {
    let tmp = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(tmp.path()).unwrap();
    let (home, repo) = (root.join("home"), root.join("repo"));
    std::fs::create_dir_all(&repo).unwrap();
    assert!(
        Command::new("git")
            .args(["init", "-q"])
            .current_dir(&repo)
            .status()
            .unwrap()
            .success()
    );
    let store = home.join(".craft").join("runs");
    std::fs::create_dir_all(&store).unwrap();
    let rows: String = (0..20)
        .map(|i| {
            let row = serde_json::json!({"ts": format!("2026-11-01T10-{i:02}-00Z"), "kind": "workflow",
                "name": "review", "project": repo, "branch": "feat/x",
                "craftVersion": env!("CARGO_PKG_VERSION"), "verdict": "Warning"});
            format!("{row}\n")
        })
        .collect();
    std::fs::write(store.join("index.jsonl"), rows).unwrap();

    let said = start(&home, &repo);
    assert!(
        said.contains("20 review run(s)") && said.contains("craft:retro"),
        "{said}"
    );
    let log = std::fs::read_to_string(home.join(".craft").join("hooks.jsonl")).unwrap();
    assert!(log.contains("\"reason\":\"retro-offer\""), "{log}");
    assert_eq!(start(&home, &repo), "", "once a day");

    let done = craft(&home, &repo, &["runs", "retro-done"], "");
    assert!(done.status.success(), "{done:?}");
    let index = std::fs::read_to_string(store.join("index.jsonl")).unwrap();
    assert!(
        index.lines().last().unwrap().contains("\"kind\":\"retro\""),
        "{index}"
    );
    std::fs::remove_file(home.join(".craft").join("retro-offered.json")).unwrap();
    assert_eq!(
        start(&home, &repo),
        "",
        "the runs before the retro are counted no more"
    );

    let switched = Command::new(env!("CARGO_BIN_EXE_craft"))
        .args(["runs", "stats", "--json", "--by", "name"])
        .env("HOME", &home)
        .output()
        .unwrap();
    assert!(switched.status.success(), "{switched:?}");
    let stats = String::from_utf8(switched.stdout).unwrap();
    assert!(
        !stats.contains("\"retro\""),
        "a retro's mark is no run: {stats}"
    );
}
