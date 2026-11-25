use super::super::record;
use super::{at, commit, ids, repo};
use crate::git::GitError;
use crate::memory::PriorDecision;
use crate::memory::priors::scope_check_on;

#[test]
fn the_trunk_fork_and_the_commit_before_a_day_come_from_git_or_fail_with_its_error() {
    let (t, _) = repo(true);
    let d = t.path();
    let fork = crate::git::trunk_fork(d).unwrap();
    let tip = at(
        d,
        "2026-05-04T00:00:00+0000",
        &["rev-parse", "refs/remotes/origin/HEAD"],
    );
    assert_eq!(fork, tip);
    assert_eq!(
        crate::git::last_before(d, &fork, "2026-04-30").unwrap(),
        None
    );
    assert!(
        crate::git::last_before(d, &fork, "2026-05-02")
            .unwrap()
            .is_some()
    );
    let option = crate::git::last_before(d, "-n", "2026-05-02").unwrap_err();
    assert!(matches!(option, GitError::NotACommit { .. }), "{option}");
    let absent = crate::git::last_before(d, "nosuchref", "2026-05-02").unwrap_err();
    assert!(matches!(absent, GitError::Failed { .. }), "{absent}");
    let (none, _) = repo(false);
    assert_eq!(crate::git::trunk_fork(none.path()), None);
}

#[test]
fn a_trunk_git_cannot_walk_raises_a_dated_record_with_why() {
    let t = tempfile::tempdir().unwrap();
    let d = t.path();
    let date = "2026-04-30T12:00:00+0000";
    at(d, date, &["init", "-q", "-b", "main"]);
    let root = commit(d, "a.rs", "0\n", date);
    commit(d, "a.rs", "1\n", "2026-05-01T09:00:00+0000");
    at(d, date, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    let head = [
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/main",
    ];
    at(d, date, &head);
    // The root's object gone: the fork resolves, the walk back to before the root fails.
    let (dir, file) = root.split_at(2);
    std::fs::remove_file(d.join(".git/objects").join(dir).join(file)).unwrap();
    let ds = [record("early", "a.rs", "", "2026-04-29")];
    let refs: Vec<&PriorDecision> = ds.iter().collect();
    let s = scope_check_on(d, &refs, "2026-05-04");
    assert_eq!(ids(&s.missing), ["early"]);
    assert_eq!(
        s.why_missing["early"],
        "git could not list the trunk's commits before the decision date 2026-04-29 — raised \
         normally"
    );
}
