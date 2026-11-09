//! Publishing on the PR, as the tests drive it: a stand-in `gh` on the PATH that keeps what it is
//! asked to post, never a real PR, and runs driven to their end.
#![expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::panic,
    reason = "the helpers are steps of the tests, failing loudly like them"
)]

use std::path::{Path, PathBuf};
use std::time::Duration;

use craft_review::publish::PostSetup;
use craft_review::step::{self, Said};
use serde_json::{Map, Value, json};

use super::{lens, opts, scout, titled, verdict};

/// A stand-in `gh` in `dir`: it logs each call, answers `pr view` with PR 7 at the head in
/// `dir/head`, lists the comments it was asked to post (the request files it kept), keeps each
/// posted request, fails every call while `dir/fail` exists, and refuses a comment on a line with
/// GitHub's 422 while `dir/no-lines` exists — on a later line of its stderr while
/// `dir/no-lines-late` does.
pub fn stand_in(dir: &Path, head: &str) -> PostSetup {
    std::fs::create_dir_all(dir.join("posted")).unwrap();
    std::fs::write(dir.join("head"), head).unwrap();
    let s = dir.display();
    let script = format!(
        r#"#!/bin/sh
S='{s}'
echo "$*" >> "$S/calls"
if [ -f "$S/fail" ]; then echo "HTTP 401: Bad credentials (https://api.github.com)" >&2; exit 1; fi
case "$1 $2" in
  "pr view") printf '{{"number":7,"url":"https://github.com/o/r/pull/7","headRefOid":"%s"}}\n' "$(cat "$S/head")" ;;
  "api --paginate") printf '['; first=1
    for f in "$S"/posted/*.json; do [ -e "$f" ] || continue; [ $first = 1 ] || printf ','; first=0; cat "$f"; done
    printf ']\n' ;;
  "api --method") n=$(ls "$S/posted" | wc -l)
    while [ $# -gt 0 ]; do if [ "$1" = --input ]; then
      if [ -f "$S/no-lines" ] && grep -q '"line"' "$2"; then echo "gh: Validation Failed (HTTP 422)" >&2; exit 1; fi
      if [ -f "$S/no-lines-late" ] && grep -q '"line"' "$2"; then printf 'gh: Validation Failed\npull_request_review_thread.line must be part of the diff (HTTP 422)\n' >&2; exit 1; fi
      cp "$2" "$S/posted/$((n+1)).json"; fi; shift; done ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
"#
    );
    let gh = dir.join("gh");
    std::fs::write(&gh, script).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let path = std::env::join_paths(
        std::iter::once(dir.to_path_buf())
            .chain(std::env::split_paths(&std::env::var_os("PATH").unwrap())),
    )
    .unwrap();
    PostSetup {
        budget: Duration::from_secs(30),
        path: Some(path),
    }
}

pub fn head(repo: &Path) -> String {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["rev-parse", "HEAD"])
        .output()
        .unwrap();
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

/// The answer to each pending task: the scout's small plan, `found` in the first lens round and
/// nothing after, no dedup groups, every verifier upholding, every critic content.
pub fn answers(s: &Value, found: &[Value]) -> Map<String, Value> {
    super::ids(s)
        .into_iter()
        .map(|id| {
            let a = match id.split('-').next().unwrap() {
                "scout" => scout("small", &["errors"]),
                "lens" if id.ends_with("-r1") && id.contains("-errors-") => lens("errors", found),
                "lens" => lens("x", &[]),
                "dedup" => json!({"groups": []}),
                "verify" => verdict(false),
                "critic" => json!({"missingLenses": [], "notes": "coverage complete"}),
                other => panic!("no answer for {other}"),
            };
            (id, a)
        })
        .collect()
}

/// A run over `repo` in `out/<name>` whose lenses find `found`, driven to its end, each submit
/// posting through `setup`.
pub fn finished(
    repo: &Path,
    out: &Path,
    name: &str,
    comment: bool,
    setup: &PostSetup,
    found: &[Value],
) -> Value {
    let run: PathBuf = out.join(name);
    let mut s = step::start(&step::StartOptions {
        run_dir: run.clone(),
        fresh: true,
        comment,
        ..opts(repo, out)
    })
    .unwrap();
    let said = Said {
        post: Some(setup),
        ..Said::default()
    };
    for _ in 0..12 {
        if s["done"] == json!(true) {
            return s;
        }
        s = step::submit_with(&run, Some(&answers(&s, found)), &said).unwrap();
    }
    panic!("the run did not finish: {s}")
}

/// A High finding of the errors lens at `src/lib.rs:<line>`.
pub fn errors(line: u32, title: &str) -> Value {
    let mut f = titled("High", line, title);
    f["source"] = json!("errors");
    f
}

/// A defect on the changed line 1 and a finding on line 40, which the diff did not change.
pub fn found() -> Vec<Value> {
    vec![
        errors(1, "f returns the wrong value"),
        errors(40, "g leaks a handle"),
    ]
}

pub fn report(s: &Value) -> String {
    std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap()
}

pub fn posted(gh: &Path) -> Vec<Value> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(gh.join("posted"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    files.sort();
    files
        .iter()
        .map(|f| serde_json::from_str(&std::fs::read_to_string(f).unwrap()).unwrap())
        .collect()
}
