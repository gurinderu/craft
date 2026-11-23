//! The stand-ins `craft review post` and `craft pr rejections` run against: the binary in a
//! directory, a stand-in `gh` on the PATH, the frozen rejection cases and a reviewed repository
//! with one run record.

use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Command, Output, Stdio};

use serde_json::{Value, json};

/// `craft <args>` in `cwd` with `bin` first on the PATH and `stdin` fed.
pub fn craft(cwd: &Path, bin: &Path, args: &[&str], stdin: &str) -> Output {
    let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap());
    let mut child = Command::new(env!("CARGO_BIN_EXE_craft"))
        .args(args)
        .current_dir(cwd)
        .env("PATH", path)
        .env("CRAFT_CODE_GRAPH", "")
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

pub fn text(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

pub fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", text(&out.stderr));
    text(&out.stdout).trim().to_owned()
}

/// A stand-in `gh` in `bin`: each call's arguments appended to `bin/calls`, then `body`.
pub fn gh(bin: &Path, body: &str) {
    std::fs::create_dir_all(bin).unwrap();
    let gh = bin.join("gh");
    let script = format!(
        "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}/calls'\n{body}\n",
        bin.display()
    );
    std::fs::write(&gh, script).unwrap();
    std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// A repository on `feat/x` with one review record carrying doubtful finding 1, and a stand-in
/// `gh` whose PR 5 of `feat/x` sits at the reviewed head — `pr view` answers with `bin/view` when it
/// exists, and the post fails (HTTP 500) while `bin/fail-post` exists.
pub struct Posting {
    _dir: tempfile::TempDir,
    pub store: tempfile::TempDir,
    pub repo: std::path::PathBuf,
    pub bin: std::path::PathBuf,
    pub record: std::path::PathBuf,
    pub head: String,
}

impl Posting {
    pub fn new() -> Self {
        Self::with(&json!({}))
    }

    /// The fixture, its record's top-level fields and `sorting` fields replaced by `extra`'s.
    pub fn with(extra: &Value) -> Self {
        let (dir, store) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let repo = std::fs::canonicalize(dir.path()).unwrap().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "feat/x"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "a"]);
        let head = git(&repo, &["rev-parse", "HEAD"]);
        let record = store
            .path()
            .join("2026-11-01T10-00-00Z-workflow-review.json");
        let finding = json!({"n": 1, "severity": "Medium", "title": "t", "file": "a.rs", "line": 3, "why": "w", "fix": "f", "source": "intent", "toolRule": "", "outsideDiff": false});
        let mut sorted = json!({"project": repo, "branch": "feat/x", "head": head, "sorting": {"defect": 0, "doubtful": 1, "inDiffJudged": true, "findings": [finding]}});
        for (k, v) in extra.as_object().unwrap() {
            if k == "sorting" {
                for (sk, sv) in v.as_object().unwrap() {
                    sorted["sorting"][sk] = sv.clone();
                }
            } else {
                sorted[k] = v.clone();
            }
        }
        std::fs::write(&record, serde_json::to_string_pretty(&sorted).unwrap()).unwrap();
        let bin = dir.path().join("bin");
        let pr = format!(
            r#"{{"number":5,"url":"https://github.com/o/r/pull/5","headRefOid":"{head}","headRefName":"feat/x","isCrossRepository":false,"state":"OPEN"}}"#
        );
        let b = bin.display();
        gh(
            &bin,
            &format!(
                "case \"$1 $2\" in\n  \"pr view\") if [ -f '{b}/view' ]; then cat '{b}/view'; else echo '{pr}'; fi ;;\n  \"pr list\") echo '[{pr}]' ;;\n  \"api --paginate\") echo '[]' ;;\n  \"api --method\") [ -f '{b}/fail-post' ] && {{ echo 'gh: Server Error (HTTP 500)' >&2; exit 1; }}; while [ $# -gt 0 ]; do [ \"$1\" = --input ] && cp \"$2\" '{b}/sent.json'; shift; done ;;\n  *) exit 3 ;;\nesac"
            ),
        );
        Self {
            _dir: dir,
            store,
            repo,
            bin,
            record,
            head,
        }
    }

    pub fn post(&self, args: &[&str]) -> Output {
        let s = self.store.path().to_str().unwrap();
        let mut all = vec!["review", "post", "--store", s];
        all.extend_from_slice(args);
        craft(&self.repo, &self.bin, &all, "")
    }
}
