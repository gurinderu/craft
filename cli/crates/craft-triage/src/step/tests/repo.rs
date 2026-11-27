//! The run reads the repository its arguments name, not the session's directory, and keeps what
//! git saw of its records' scopes from the submit that asked it to the end, never asking again
//! (realm @nick/craft, nodes #709, #710).

use std::collections::BTreeSet;
use std::path::Path;
use std::process::Command;

use craft_store::js::Js;

use crate::field::At;
use serde_json::{Value, json};

use super::recording::{kept, recording};
use super::{answers, case, git_repo, opts_of};
use crate::parity::answers::CaseAnswers;
use crate::state;
use crate::step::{Said, start, submit};

const CASE: &str = "the memory sets findings aside, defers one, raises a High again, covers one by a rule and flags one against it";

fn git(repo: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(repo)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {out:?}");
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

/// The case with every recalled record anchored at `head`, and the ids of those that carry a
/// commit: their scopes are unchanged in a repository whose head is `head`.
fn anchored(c: &Js, head: &str) -> (Js, BTreeSet<String>) {
    let mut v = Value::try_from(c).unwrap();
    let mut ids = BTreeSet::new();
    for kind in ["decisions", "questions", "rules"] {
        let list = v["answers"]["memoryRecall"][kind].as_array_mut();
        for r in list.into_iter().flatten() {
            if r.get("commit").is_some() {
                r["commit"] = json!(head);
                ids.insert(r["id"].as_str().unwrap().to_owned());
            }
        }
    }
    (craft_store::js::parse(&v.to_string()).unwrap(), ids)
}

/// A repository holding every path the case's records scope, committed; its head.
fn scoped_repo(c: &Js) -> (tempfile::TempDir, String) {
    let repo = git_repo();
    let recall = c.at("answers").at("memoryRecall");
    for kind in ["decisions", "questions", "rules"] {
        for r in recall.at(kind).as_arr().unwrap_or_default() {
            if let Some(scope) = r.at("scope").as_str() {
                let file = repo.path().join(scope);
                std::fs::create_dir_all(file.parent().unwrap()).unwrap();
                std::fs::write(&file, "fn f() {}\n").unwrap();
            }
        }
    }
    git(repo.path(), &["add", "-A"]);
    git(
        repo.path(),
        &[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "commit",
            "-qm",
            "scoped",
        ],
    );
    let head = git(repo.path(), &["rev-parse", "HEAD"]);
    (repo, head)
}

#[test]
fn a_run_reads_the_repository_it_names_and_never_asks_git_twice() {
    let (repo, head) = scoped_repo(&case(CASE));
    let (c, ids) = anchored(&case(CASE), &head);
    assert!(
        !ids.is_empty(),
        "the case recalls records anchored at a commit"
    );
    // The session's directory is a repository too, without that commit: read there, every
    // record's scope would be missing.
    let (session, dir) = (git_repo(), tempfile::tempdir().unwrap());
    let a = CaseAnswers::new(&c, None);
    let mut opts = opts_of(&c, repo.path(), dir.path());
    opts.args.repo = repo.path().display().to_string();
    opts.cwd = session.path().into();
    opts.args.record = Some(recording());
    let w = kept(Ok(
        json!({"ok": true, "reason": "", "file": "/store/r.json"}),
    ));
    let named = repo.path().canonicalize().unwrap();
    let mut step = start(&opts, &w).unwrap();
    assert_eq!(state::load(dir.path()).unwrap().cwd, named);
    let mut asked = false;
    for _ in 0..40 {
        if step["done"] == Value::Bool(true) {
            break;
        }
        let given = answers(dir.path(), &a);
        step = submit(dir.path(), Some(&given), &Said::default(), &w).unwrap();
        if !asked && !state::load(dir.path()).unwrap().seen.checked.is_empty() {
            asked = true;
            // Git asked once; from here a second question would find no repository and read
            // every scope as missing.
            std::fs::rename(repo.path().join(".git"), repo.path().join(".git-gone")).unwrap();
        }
    }
    assert!(asked, "git was asked about the recalled records' scopes");
    assert_eq!(step["done"], Value::Bool(true), "the run ended: {step}");
    let seen = state::load(dir.path()).unwrap().seen;
    // Every record git checked reads unchanged: in the session's repository they would be missing.
    assert!(
        !seen.checked.is_empty() && seen.checked.is_subset(&ids),
        "{seen:?}"
    );
    assert!(
        seen.checked.is_subset(&seen.unchanged),
        "read in the named repository: {seen:?}"
    );
    assert!(
        seen.missing.is_empty() && seen.why_missing.is_empty(),
        "git was not asked again: {seen:?}"
    );
    let calls = w.calls.borrow();
    let [(_, _, req)] = calls.as_slice() else {
        panic!("one write: {calls:?}")
    };
    assert_eq!(
        req["repo"],
        json!(named.display().to_string()),
        "filed of the named repository"
    );
}
