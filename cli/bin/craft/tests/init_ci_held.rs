//! `craft init --propose` and the CI map it holds (realm @nick/craft, node #482): a held entry
//! `--write` would refuse — its check holding an expression, or a job of another workflow reported
//! under it — carries the refusal `--write` gives as `refused`; one written fine carries none.
//! HOME is a temporary directory.
#![expect(
    clippy::unwrap_used,
    reason = "the fixture helpers fail the test loudly, like the tests they serve"
)]

use std::path::Path;
use std::process::{Command, Output};

use serde_json::Value;

const WORKFLOW: &str = "jobs:
  rust:
    name: Rust
    steps:
      - run: cargo clippy --all-targets -- -D warnings
";

fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .output()
        .unwrap();
    assert!(ok.status.success(), "git {args:?}");
}

fn craft(t: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_craft"))
        .args(args)
        .env("HOME", t.join("home"))
        .env_remove("CRAFT_ROOT")
        .output()
        .unwrap()
}

fn json_of(out: &Output) -> Value {
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(out.status.success(), "{err}");
    serde_json::from_slice(&out.stdout).unwrap()
}

/// The refusal `--write` gives for `held` passed back as `ci` prints it.
fn write_refusal(t: &Path, r: &str, held: &Value) -> String {
    let out = craft(
        t,
        &["init", "--write", "--cwd", r, "--ci", &held.to_string()],
    );
    assert!(!out.status.success(), "{held}");
    String::from_utf8_lossy(&out.stderr).into_owned()
}

#[test]
fn a_held_entry_the_write_would_refuse_is_proposed_with_its_refusal() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    std::fs::create_dir_all(repo.join(".github/workflows")).unwrap();
    std::fs::write(repo.join(".github/workflows/ci.yml"), WORKFLOW).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "init"]);
    let (r, t) = (repo.display().to_string(), tmp.path());
    let first = json_of(&craft(t, &["init", "--propose", "--cwd", &r]));
    let ci = first["ciCandidates"]["resolved"][0]["ci"].as_str().unwrap();
    json_of(&craft(t, &["init", "--write", "--cwd", &r, "--ci", ci]));
    let fine = json_of(&craft(t, &["init", "--propose", "--cwd", &r]));
    assert!(fine["ci"][0].get("refused").is_none(), "{fine}");

    let docs = "jobs:\n  docs:\n    name: Rust (docs)\n    steps:\n      - run: mdbook build\n";
    std::fs::write(repo.join(".github/workflows/docs.yml"), docs).unwrap();
    let sibling = json_of(&craft(t, &["init", "--propose", "--cwd", &r]));
    let why = sibling["ci"][0]["refused"].as_str().unwrap();
    assert!(why.contains("\"Rust (docs)\""), "{why}");
    let mut held = sibling["ci"][0].clone();
    held.as_object_mut().unwrap().remove("refused");
    assert!(
        write_refusal(t, &r, &held).contains(why),
        "the write's own reason"
    );

    let profile = fine["profile"].as_str().unwrap();
    let text = std::fs::read_to_string(profile).unwrap();
    let expr = text.replace("check = \"Rust\"", "check = \"Rust (${{ matrix.arch }})\"");
    std::fs::write(profile, expr).unwrap();
    let again = json_of(&craft(t, &["init", "--propose", "--cwd", &r]));
    assert!(
        again["ci"][0]["refused"]
            .as_str()
            .unwrap()
            .contains("unexpanded"),
        "{again}"
    );
}
