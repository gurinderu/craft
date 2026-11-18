//! `craft init` and the code graph (realm @nick/craft, node #529): `--write` asks
//! `codebase-memory-mcp` whether it answers and which project indexes the repository, writes that
//! as the profile's `[code_graph]`, and says so; a graph that is missing or fails is said to be
//! not available, and init still succeeds. A stand-in program on a PATH of the test's own.
#![expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "the fixture helpers fail the test loudly, like the tests they serve"
)]

mod common;

use std::path::Path;
use std::process::Command;

use serde_json::Value;

fn repo(t: &Path) -> String {
    let d = t.join("repo");
    std::fs::create_dir_all(&d).unwrap();
    let ok = Command::new("git")
        .args(["init", "-q", "-b", "main"])
        .arg(&d)
        .status()
        .unwrap();
    assert!(ok.success());
    d.canonicalize().unwrap().display().to_string()
}

/// `craft init --write` with `bin` first on PATH, its JSON answer and the profile it wrote.
fn write(t: &Path, bin: &Path, repo: &str) -> (Value, String) {
    let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap());
    let out = Command::new(env!("CARGO_BIN_EXE_craft"))
        .args(["init", "--write", "--cwd", repo])
        .env("HOME", t.join("home"))
        .env("PATH", path)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    let profile = std::fs::read_to_string(v["profile"].as_str().unwrap()).unwrap();
    (v, profile)
}

#[test]
fn init_writes_the_code_graph_that_answers_for_the_repository() {
    let tmp = tempfile::tempdir().unwrap();
    let t = tmp.path();
    let repo = repo(t);
    let bin = t.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let listed = format!(
        "{{\"projects\":[{{\"name\":\"other\",\"root_path\":\"/x\"}},{{\"name\":\"mine\",\"root_path\":\"{repo}\"}}]}}"
    );
    let script = format!(
        "#!/bin/sh\n[ \"$1 $2 $3\" = 'cli --quiet list_projects' ] || exit 2\necho '{listed}'\n"
    );
    common::write_executable(&bin.join("codebase-memory-mcp"), &script).unwrap();
    let (v, profile) = write(t, &bin, &repo);
    assert_eq!(v["codeGraph"]["project"], "mine");
    assert!(
        v["codeGraphSays"]
            .as_str()
            .unwrap()
            .contains("indexes this repository as mine")
    );
    assert!(profile.contains("[code_graph]"), "{profile}");
    assert!(
        profile.contains("tool = \"codebase-memory-mcp\""),
        "{profile}"
    );
    assert!(profile.contains("available = true"), "{profile}");
    assert!(profile.contains("project = \"mine\""), "{profile}");
}

#[test]
fn init_says_a_failing_code_graph_is_not_available_and_still_writes() {
    let tmp = tempfile::tempdir().unwrap();
    let t = tmp.path();
    let repo = repo(t);
    let bin = t.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let script = "#!/bin/sh\necho 'database locked' >&2\nexit 3\n";
    common::write_executable(&bin.join("codebase-memory-mcp"), script).unwrap();
    let (v, profile) = write(t, &bin, &repo);
    let says = v["codeGraphSays"].as_str().unwrap();
    assert!(
        says.contains("is not available (list_projects: database locked)"),
        "{says}"
    );
    assert!(says.contains("name search alone"), "{says}");
    assert!(profile.contains("available = false"), "{profile}");
}
