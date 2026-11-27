//! The run reads the repository its arguments name, not the session's directory, and keeps what
//! git saw of its records' scopes from the submit that asked it to the end (realm @nick/craft,
//! nodes #709, #710).

use serde_json::{Value, json};

use super::recording::{kept, recording};
use super::{answers, case, git_repo, opts_of};
use crate::parity::answers::CaseAnswers;
use crate::state;
use crate::step::{Said, start, submit};

const CASE: &str = "the memory sets findings aside, defers one, raises a High again, covers one by a rule and flags one against it";

#[test]
fn a_run_reads_the_repository_it_names_and_keeps_what_git_saw_to_its_end() {
    let c = case(CASE);
    let (repo, session, dir) = (git_repo(), git_repo(), tempfile::tempdir().unwrap());
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
    // The submit after which git first saw a record's scope, and what it saw.
    let mut first = None;
    for _ in 0..40 {
        if step["done"] == Value::Bool(true) {
            break;
        }
        let given = answers(dir.path(), &a);
        step = submit(dir.path(), Some(&given), &Said::default(), &w).unwrap();
        let seen = state::load(dir.path()).unwrap().seen;
        if first.is_none() && !seen.checked.is_empty() {
            first = Some(seen.checked);
        }
    }
    assert_eq!(step["done"], Value::Bool(true), "the run ended: {step}");
    let first =
        first.expect("git was asked about the recalled records' scopes and the state kept it");
    let last = state::load(dir.path()).unwrap().seen.checked;
    assert!(
        first.is_subset(&last),
        "what git saw stays seen: {first:?} → {last:?}"
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
