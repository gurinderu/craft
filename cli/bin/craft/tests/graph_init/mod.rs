//! What the `craft init` tests of the code graph share: a repository, a stand-in
//! `codebase-memory-mcp` on a PATH of the test's own, and `craft init` run with it.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

#[path = "../../../../test-support/exe.rs"]
mod exe;

/// A git repository under `t`, its path as git names it.
pub fn repo(t: &Path) -> String {
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

/// Puts a stand-in `codebase-memory-mcp` running `script` in `t`'s own bin directory, and
/// returns it.
pub fn stub(t: &Path, script: &str) -> PathBuf {
    let bin = t.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    exe::write_executable(&bin.join("codebase-memory-mcp"), script).unwrap();
    bin
}

/// A stand-in whose `list_projects` names `mine` at `repo`.
pub fn indexing(t: &Path, repo: &str) -> PathBuf {
    let listed = format!(
        "{{\"projects\":[{{\"name\":\"other\",\"root_path\":\"/x\"}},{{\"name\":\"mine\",\"root_path\":\"{repo}\"}}]}}"
    );
    stub(
        t,
        &format!(
            "#!/bin/sh\n[ \"$1 $2 $3\" = 'cli --quiet list_projects' ] || exit 2\necho '{listed}'\n"
        ),
    )
}

/// `craft init <mode> --cwd <repo>` with `bin` first on PATH: its JSON answer and the profile
/// it left.
pub fn init(t: &Path, bin: &Path, repo: &str, mode: &str) -> (Value, String) {
    let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap());
    let out = Command::new(env!("CARGO_BIN_EXE_craft"))
        .args(["init", mode, "--cwd", repo])
        .env("HOME", t.join("home"))
        .env("PATH", path)
        .env_remove("CRAFT_ROOT")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    let profile = std::fs::read_to_string(v["profile"].as_str().unwrap()).unwrap_or_default();
    (v, profile)
}
