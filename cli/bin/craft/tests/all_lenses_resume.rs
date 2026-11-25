//! `review run --all-lenses` beside `--run`: a resumed run keeps the lenses it started with, so the
//! flag is refused before anything runs (exit 2) rather than read as taken (realm @nick/craft, node
//! #644).

use std::process::Command;

#[test]
fn all_lenses_beside_a_resume_is_refused_before_any_task() {
    let tmp = tempfile::tempdir().unwrap();
    let run = tmp.path().join("run");
    let out = Command::new(env!("CARGO_BIN_EXE_craft"))
        .args([
            "review",
            "run",
            "--backend",
            "codex",
            "--all-lenses",
            "--run",
        ])
        .arg(&run)
        .arg("--cwd")
        .arg(tmp.path())
        .env("HOME", tmp.path())
        .env("CRAFT_CODE_GRAPH", "")
        .output()
        .unwrap();
    let said = String::from_utf8_lossy(&out.stdout);
    assert_eq!(out.status.code(), Some(2), "{out:?}");
    assert!(said.contains("--all-lenses goes with a start"), "{said}");
    assert!(said.contains("Nothing ran"), "{said}");
    assert!(!run.exists(), "no run was touched");
}

#[test]
fn all_lenses_alone_and_a_resume_alone_are_not_refused_for_it() {
    let tmp = tempfile::tempdir().unwrap();
    for with in [&["--all-lenses"][..], &["--run", "/nonexistent/run"][..]] {
        let out = Command::new(env!("CARGO_BIN_EXE_craft"))
            .args([
                "review",
                "run",
                "--backend",
                "codex",
                "--host-bin",
                "/nonexistent/codex",
            ])
            .args(with)
            .arg("--cwd")
            .arg(tmp.path())
            .env("HOME", tmp.path())
            .env("CRAFT_CODE_GRAPH", "")
            .output()
            .unwrap();
        let said = String::from_utf8_lossy(&out.stdout);
        assert!(
            !said.contains("--all-lenses goes with a start"),
            "{with:?}: {said}"
        );
    }
}
