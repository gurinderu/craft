//! A record linking its pull request in a `git clone --depth 1` whose tip is that request's
//! landing, as CI checks out right after a merge: the merge's parents are cut off, so its branch
//! cannot be read and counts as a change outside the request (realm @nick/craft, node #701).

use super::super::{at, ids};
use super::{Landed, records, repo};
use crate::memory::PriorDecision;
use crate::memory::priors::scope_check_on;

const LATE: &str = "2026-05-11T00:00:00+0000";

/// A depth-1 clone of the trunk `how` builds, in `c` under the directory returned, its origin
/// named back to GitHub.
fn shallow(how: Landed) -> tempfile::TempDir {
    let full = repo(how);
    let t = tempfile::tempdir().unwrap();
    let url = format!("file://{}", full.path().display());
    at(t.path(), LATE, &["clone", "-q", "--depth", "1", &url, "c"]);
    let github = "git@github.com:owner/repo.git";
    at(
        &t.path().join("c"),
        LATE,
        &["remote", "set-url", "origin", github],
    );
    t
}

/// What the scope check of the records undated, dated after today and dated after the merge
/// names changed outside the pull request and unchanged in `how`'s shallow clone.
fn seen(how: Landed) -> (Vec<String>, Vec<String>) {
    let t = shallow(how);
    let ds: Vec<PriorDecision> = records()
        .into_iter()
        .filter(|d| ["a-ahead", "a-undated", "p-after"].contains(&d.id.as_str()))
        .collect();
    let refs: Vec<&PriorDecision> = ds.iter().collect();
    let s = scope_check_on(&t.path().join("c"), &refs, "2026-05-11");
    assert!(s.missing.is_empty(), "{:?}", s.why_missing);
    assert_eq!(s.merged.len(), ds.len(), "{:?}", s.merged);
    let own =
        |set: &std::collections::BTreeSet<String>| ids(set).into_iter().map(String::from).collect();
    (own(&s.between), own(&s.unchanged))
}

#[test]
fn a_merge_whose_second_parent_the_clone_cut_off_is_changed_outside_the_pull_request() {
    let (between, unchanged) = seen(Landed::Stale);
    assert_eq!(between, ["a-ahead", "a-undated", "p-after"]);
    assert!(unchanged.is_empty(), "{unchanged:?}");
}

#[test]
fn a_squash_has_no_branch_there_either_and_its_cut_off_first_parent_changes_its_dates_window() {
    let (between, unchanged) = seen(Landed::Squashed);
    assert_eq!(between, ["p-after"]);
    assert_eq!(unchanged, ["a-ahead", "a-undated"]);
}

#[test]
fn a_second_parent_the_clone_cut_off_is_no_commit_of_it() {
    let t = shallow(Landed::Stale);
    let c = t.path().join("c");
    let cut = crate::git::second_parent(&c, "HEAD").unwrap_err();
    assert!(
        matches!(cut, crate::git::GitError::NotACommit { .. }),
        "{cut}"
    );
    let squash = shallow(Landed::Squashed);
    let tip = crate::git::second_parent(&squash.path().join("c"), "HEAD");
    assert_eq!(tip.unwrap(), None);
}
