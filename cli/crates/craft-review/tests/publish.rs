//! Publishing on the PR (`comment`): a finished run posts its defects through `gh` — here a stand-in
//! on the PATH that keeps what it is asked to post, never a real PR — lists the doubtful findings
//! for the reviewer, posts nothing a second time over the same head, names a gh failure without
//! touching the verdict, and posts nothing unasked.

#![expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::panic,
    reason = "the helpers are steps of the tests, failing loudly like them"
)]

mod common;

use std::path::{Path, PathBuf};
use std::time::Duration;

use common::{fixture, lens, opts, scout, titled, verdict};
use craft_review::publish::PostSetup;
use craft_review::step::{self, Said};
use serde_json::{Map, Value, json};

/// A stand-in `gh` in `dir`: it logs each call, answers `pr view` with PR 7 at the head in
/// `dir/head`, lists the comments it was asked to post (the request files it kept), keeps each
/// posted request, and fails every call while `dir/fail` exists.
fn stand_in(dir: &Path, head: &str) -> PostSetup {
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
    while [ $# -gt 0 ]; do if [ "$1" = --input ]; then cp "$2" "$S/posted/$((n+1)).json"; fi; shift; done ;;
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

fn head(repo: &Path) -> String {
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
fn answers(s: &Value, found: &[Value]) -> Map<String, Value> {
    common::ids(s)
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
fn finished(
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
fn errors(line: u32, title: &str) -> Value {
    let mut f = titled("High", line, title);
    f["source"] = json!("errors");
    f
}

/// A defect on the changed line 1 and a finding on line 40, which the diff did not change.
fn found() -> Vec<Value> {
    vec![
        errors(1, "f returns the wrong value"),
        errors(40, "g leaks a handle"),
    ]
}

fn report(s: &Value) -> String {
    std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap()
}

fn posted(gh: &Path) -> Vec<Value> {
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

#[test]
fn a_finished_run_posts_its_defects_and_lists_the_doubtful_for_the_reviewer() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let gh = out.path().join("gh");
    let setup = stand_in(&gh, &head(repo.path()));
    let s = finished(repo.path(), out.path(), "run", true, &setup, &found());
    assert_eq!(s["verdict"], json!("Block"));
    let sorting = &s["sorting"];
    assert_eq!(
        (
            &sorting["defect"],
            &sorting["doubtful"],
            &sorting["inDiffJudged"]
        ),
        (&json!(1), &json!(1), &json!(true))
    );
    let d = &sorting["findings"][0];
    assert_eq!(
        (&d["n"], &d["line"], &d["title"], &d["outsideDiff"]),
        (
            &json!(1),
            &json!(40),
            &json!("g leaks a handle"),
            &json!(true)
        )
    );
    assert_eq!(s["memoryContradictions"]["count"], json!(0));
    let pr = &s["prComments"];
    assert_eq!(
        (
            &pr["pr"],
            &pr["requested"],
            &pr["posted"],
            &pr["already"],
            &pr["error"]
        ),
        (&json!(7), &json!(1), &json!(1), &json!(0), &json!(""))
    );
    let sent = posted(&gh);
    assert_eq!(sent.len(), 1);
    let req = &sent[0];
    assert_eq!(
        (&req["commit_id"], &req["path"], &req["line"], &req["side"]),
        (
            &json!(head(repo.path())),
            &json!("src/lib.rs"),
            &json!(1),
            &json!("RIGHT")
        )
    );
    let body = req["body"].as_str().unwrap();
    assert!(
        body.starts_with(
            "[High] f returns the wrong value\n\nwrong — fix it\n\n<!-- craft-lens: errors -->\n"
        ),
        "{body}"
    );
    assert!(body.ends_with("<!-- craft-finding -->"), "{body}");
    common::assert_contains_all(
        &report(&s),
        &[
            "## Doubtful — for the reviewer, not posted",
            "1. High · `src/lib.rs:40` · g leaks a handle · doubtful: its line is outside the lines the diff changed",
            "## PR comments\n- posted 1 of 1 defect(s) · 0 already on the PR",
            "PR #7 https://github.com/o/r/pull/7",
        ],
    );
}

#[test]
fn a_second_run_over_the_same_head_posts_nothing_again() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let gh = out.path().join("gh");
    let setup = stand_in(&gh, &head(repo.path()));
    finished(repo.path(), out.path(), "first", true, &setup, &found());
    let s = finished(repo.path(), out.path(), "second", true, &setup, &found());
    let pr = &s["prComments"];
    assert_eq!(
        (&pr["requested"], &pr["posted"], &pr["already"]),
        (&json!(1), &json!(0), &json!(1))
    );
    assert_eq!(posted(&gh).len(), 1, "one comment on the PR after two runs");
    assert!(report(&s).contains(
        "posted 0 of 1 defect(s) · 1 already on the PR (craft-finding marker), not posted again"
    ));
}

#[test]
fn two_defects_sharing_a_title_on_one_file_are_both_posted_once() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let lines: String = (1..=50).map(|n| format!("pub fn f{n}() {{}}\n")).collect();
    std::fs::write(repo.path().join("src/lib.rs"), lines).unwrap();
    common::git(repo.path(), &["commit", "-qam", "feat: fifty functions"]);
    let gh = out.path().join("gh");
    let setup = stand_in(&gh, &head(repo.path()));
    let same = vec![errors(12, "unchecked index"), errors(40, "unchecked index")];
    let s = finished(repo.path(), out.path(), "first", true, &setup, &same);
    let pr = &s["prComments"];
    assert_eq!(
        (&pr["requested"], &pr["posted"], &pr["already"]),
        (&json!(2), &json!(2), &json!(0))
    );
    let at: Vec<Value> = posted(&gh).iter().map(|r| r["line"].clone()).collect();
    assert_eq!(at, [json!(12), json!(40)]);
    let s = finished(repo.path(), out.path(), "second", true, &setup, &same);
    let pr = &s["prComments"];
    assert_eq!((&pr["posted"], &pr["already"]), (&json!(0), &json!(2)));
    assert_eq!(posted(&gh).len(), 2, "neither is posted again");
}

#[test]
fn a_gh_failure_is_named_and_the_verdict_stands() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let gh = out.path().join("gh");
    let setup = stand_in(&gh, &head(repo.path()));
    std::fs::write(gh.join("fail"), "").unwrap();
    let s = finished(repo.path(), out.path(), "run", true, &setup, &found());
    assert_eq!(s["verdict"], json!("Block"));
    assert_eq!(
        s["notRun"],
        json!([]),
        "a failed post is no gap in the review"
    );
    let pr = &s["prComments"];
    assert_eq!((&pr["posted"], &pr["failed"]), (&json!(0), &json!(0)));
    let error = pr["error"].as_str().unwrap();
    assert!(
        error.contains("gh pr view failed: HTTP 401: Bad credentials"),
        "{error}"
    );
    assert!(
        report(&s).contains("- ⚠️ nothing was posted (1 defect(s)): gh pr view failed: HTTP 401")
    );
    assert!(posted(&gh).is_empty());
}

#[test]
fn a_missing_gh_and_a_pr_at_another_head_are_named() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let empty = out.path().join("no-gh");
    std::fs::create_dir_all(&empty).unwrap();
    let missing = PostSetup {
        budget: Duration::from_secs(30),
        path: Some(empty.into_os_string()),
    };
    let s = finished(repo.path(), out.path(), "a", true, &missing, &found());
    assert_eq!(
        s["prComments"]["error"],
        json!("gh is not installed (no `gh` on the PATH)")
    );
    let gh = out.path().join("gh");
    let setup = stand_in(&gh, "0123456789abcdef0123456789abcdef01234567");
    let s = finished(repo.path(), out.path(), "b", true, &setup, &found());
    let reason = s["prComments"]["reason"].as_str().unwrap();
    assert!(
        reason.starts_with("the PR's head 0123456789ab is not the reviewed head"),
        "{reason}"
    );
    assert!(posted(&gh).is_empty());
}

#[test]
fn without_comment_nothing_is_sorted_or_posted() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let gh = out.path().join("gh");
    let setup = stand_in(&gh, &head(repo.path()));
    let s = finished(repo.path(), out.path(), "run", false, &setup, &found());
    assert_eq!(
        (&s["sorting"], &s["prComments"]),
        (&Value::Null, &Value::Null)
    );
    assert_eq!(s["memoryContradictions"]["count"], json!(0));
    assert!(!gh.join("calls").exists(), "gh was never called");
    let r = report(&s);
    assert!(
        !r.contains("## Doubtful") && !r.contains("## PR comments"),
        "{r}"
    );
}
