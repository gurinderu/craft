//! `craft init`'s `[project]` properties (realm @nick/craft, node #654): `--propose` offers what the
//! repository's tracked files say — a library, its rule files, controllers, directories named for
//! security — and shows what the profile holds as the flags a write takes back; `--write` records
//! what the reviewer confirmed, replaced on each write. HOME is a temporary directory.
#![expect(
    clippy::unwrap_used,
    reason = "the fixture helpers fail the test loudly, like the tests they serve"
)]

use std::path::Path;
use std::process::{Command, Output};

use serde_json::{Value, json};

fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(ok.status.success(), "git {args:?}");
}

/// A repository tracking `files`, each written empty but for the manifests given text.
fn repo(t: &Path, files: &[(&str, &str)]) -> String {
    let repo = t.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    for (f, text) in files {
        let path = repo.join(f);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }
    git(&repo, &["add", "."]);
    repo.display().to_string()
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

fn project(t: &Path, repo: &str) -> Value {
    json_of(&craft(t, &["init", "--propose", "--cwd", repo]))
        .get("project")
        .cloned()
        .unwrap()
}

fn write(t: &Path, repo: &str, more: &[&str]) -> Output {
    let mut args = vec!["init", "--write", "--cwd", repo];
    args.extend(more);
    craft(t, &args)
}

#[test]
fn propose_offers_what_the_tracked_files_say_each_with_its_files() {
    let tmp = tempfile::tempdir().unwrap();
    let t = tmp.path();
    let cargo = "[package]\nname = \"op\"\n[dependencies]\nkube = \"1\"\n";
    let repo = repo(
        t,
        &[
            ("Cargo.toml", cargo),
            ("src/lib.rs", ""),
            ("src/auth/token.rs", ""),
            ("AGENTS.md", ""),
            ("tests/secrets/t.rs", ""),
        ],
    );
    let p = project(t, &repo);
    let o = &p["offered"];
    assert_eq!(o["library"], json!({"value": true, "from": ["Cargo.toml"]}));
    assert_eq!(o["rules"]["value"], json!(["AGENTS.md"]));
    assert_eq!(
        o["controllers"],
        json!({"value": true, "from": ["Cargo.toml"]})
    );
    assert_eq!(o["security_paths"], json!(["src/auth"]), "{o}");
    assert_eq!((&p["held"], &p["flags"]), (&json!({}), &json!([])));
    assert_eq!(p["offeredUnread"], Value::Null);
}

#[test]
fn write_records_the_confirmed_properties_replaces_them_and_refuses_a_path_twice() {
    let tmp = tempfile::tempdir().unwrap();
    let t = tmp.path();
    let repo = repo(t, &[("README.md", "")]);
    let flags = [
        "--library",
        "no",
        "--rule",
        "CONTRIBUTING.md",
        "--security-path",
        "src/auth",
        "--contract",
        "spec/*.cddl",
        "--controllers",
    ];
    let wrote = json_of(&write(t, &repo, &flags));
    assert_eq!(wrote["project"]["flags"], json!(flags));
    let p = project(t, &repo);
    assert_eq!(
        p["flags"],
        json!(flags),
        "a write takes back what propose prints"
    );
    assert_eq!(p["held"]["security_paths"], json!(["src/auth"]));

    let twice = write(t, &repo, &["--rule", "A.md", "--rule", "A.md"]);
    assert_ne!(twice.status.code(), Some(0));
    assert!(
        String::from_utf8_lossy(&twice.stderr).contains("named twice"),
        "{twice:?}"
    );
    assert_ne!(
        write(t, &repo, &["--library", "maybe"]).status.code(),
        Some(0)
    );
    assert_eq!(
        project(t, &repo)["flags"],
        json!(flags),
        "a refused write leaves it as it was"
    );

    json_of(&write(t, &repo, &[]));
    assert_eq!(
        project(t, &repo)["held"],
        json!({}),
        "a write naming none leaves none"
    );
    let beside = craft(t, &["init", "--propose", "--cwd", &repo, "--controllers"]);
    assert_eq!(
        beside.status.code(),
        Some(2),
        "a write flag beside propose is refused"
    );
}
