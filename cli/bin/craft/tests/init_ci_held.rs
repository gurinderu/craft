//! `craft init --propose` and the CI map it holds (realm @nick/craft, node #482): a held entry that
//! cannot be kept as it is — `--write` refuses it passed back, or the gate skips it — carries why
//! as `unusable`, the write's own reason; one written fine, or only stale, carries none.
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

/// The refusal `--write` gives for `held` passed back as `ci` prints it, `unusable` left out.
fn write_refusal(t: &Path, r: &str, held: &Value) -> String {
    let mut held = held.clone();
    held.as_object_mut().unwrap().remove("unusable");
    let out = craft(
        t,
        &["init", "--write", "--cwd", r, "--ci", &held.to_string()],
    );
    assert!(!out.status.success(), "{held}");
    let err = String::from_utf8_lossy(&out.stderr);
    err.trim().strip_prefix("craft: ").unwrap().to_owned()
}

/// The held entry `--propose` prints now, and why it cannot be kept, if so.
fn held(t: &Path, r: &str) -> (Value, Option<String>) {
    let out = json_of(&craft(t, &["init", "--propose", "--cwd", r]));
    let e = out.get("ci").and_then(|c| c.get(0)).cloned().unwrap();
    let why = e.get("unusable").map(|w| w.as_str().unwrap().to_owned());
    (e, why)
}

#[test]
fn a_held_entry_that_cannot_be_kept_is_proposed_with_why() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    let (wf, docs) = (".github/workflows/ci.yml", ".github/workflows/docs.yml");
    std::fs::create_dir_all(repo.join(".github/workflows")).unwrap();
    std::fs::write(repo.join(wf), WORKFLOW).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "init"]);
    let (r, t) = (repo.display().to_string(), tmp.path());
    let first = json_of(&craft(t, &["init", "--propose", "--cwd", &r]));
    let ci = first["ciCandidates"]["resolved"][0]["ci"].as_str().unwrap();
    let wrote = json_of(&craft(t, &["init", "--write", "--cwd", &r, "--ci", ci]));
    let (fine, why) = held(t, &r);
    assert_eq!((&fine, why), (&wrote["ci"][0], None), "written fine");

    let sibling = "jobs:\n  docs:\n    name: Rust (docs)\n    steps:\n      - run: mdbook build\n";
    std::fs::write(repo.join(docs), sibling).unwrap();
    let (e, why) = held(t, &r);
    let why = why.unwrap();
    assert!(why.contains("\"Rust (docs)\""), "{why}");
    assert_eq!(write_refusal(t, &r, &e), why, "the write's own reason");

    std::fs::remove_file(repo.join(docs)).unwrap();
    std::fs::write(repo.join(wf), format!("{WORKFLOW}  more:\n")).unwrap();
    let (stale, why) = held(t, &r);
    assert_eq!(
        (&stale, why),
        (&fine, None),
        "stale, kept until confirmed again"
    );
    std::fs::write(repo.join(docs), sibling).unwrap();
    let (_, why) = held(t, &r);
    let why = why.unwrap();
    assert!(why.contains("\"Rust (docs)\""), "the gate skips it: {why}");

    let profile = first["profile"].as_str().unwrap();
    let text = std::fs::read_to_string(profile).unwrap();
    let expr = text.replace("check = \"Rust\"", "check = \"Rust (${{ matrix.arch }})\"");
    std::fs::write(profile, expr).unwrap();
    let (e, why) = held(t, &r);
    let why = why.unwrap();
    assert!(why.contains("unexpanded"), "{why}");
    assert_eq!(write_refusal(t, &r, &e), why, "the write's own reason");
}
