use std::collections::BTreeSet;
use std::path::Path;
use std::process::Command;

use super::record;
use crate::memory::PriorDecision;
use crate::memory::priors::scope_check_on;

mod failing;
mod fork;
mod merge;

/// Runs git in `dir` with author and committer dated `date`, its stdout trimmed.
pub(in crate::memory::anchor) fn at(dir: &Path, date: &str, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .env("GIT_AUTHOR_DATE", date)
        .env("GIT_COMMITTER_DATE", date)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}");
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

/// Commits `text` into `file` at `date`, returning the commit.
pub(in crate::memory::anchor) fn commit(dir: &Path, file: &str, text: &str, date: &str) -> String {
    std::fs::write(dir.join(file), text).unwrap();
    at(dir, date, &["add", "."]);
    at(dir, date, &["commit", "-qm", file]);
    at(dir, date, &["rev-parse", "HEAD"])
}

pub(super) fn ids(set: &BTreeSet<String>) -> Vec<&str> {
    set.iter().map(String::as_str).collect()
}

/// A trunk whose last commits straddle the start of 2026-05-02 anywhere (2026-05-01 10:00 UTC),
/// a side branch dated before that day merged into it after, and `HEAD` on a branch off the trunk
/// with a backdated commit — `origin/HEAD` naming the trunk unless `trunk` is false.
pub(super) fn repo(trunk: bool) -> (tempfile::TempDir, String) {
    let t = tempfile::tempdir().unwrap();
    let d = t.path();
    at(d, "2026-04-30T12:00:00+0000", &["init", "-q", "-b", "main"]);
    std::fs::create_dir_all(d.join("src")).unwrap();
    for f in ["a", "b", "d"] {
        std::fs::write(d.join(format!("src/{f}.rs")), "0\n").unwrap();
    }
    let first = commit(d, "src/b.rs", "0\n", "2026-04-30T12:00:00+0000");
    // 09:00 UTC on the 1st: before the 2nd began anywhere, so the base of a record of the 2nd.
    commit(d, "src/b.rs", "1\n", "2026-05-01T09:00:00+0000");
    at(
        d,
        "2026-05-01T09:30:00+0000",
        &["checkout", "-qb", "side", &first],
    );
    // Dated before the 2nd, merged after it: never the base.
    commit(d, "src/d.rs", "side\n", "2026-05-01T09:30:00+0000");
    at(d, "2026-05-01T15:00:00+0000", &["checkout", "-q", "main"]);
    // 15:00 UTC on the 1st: the 2nd had begun at +14:00, so after a record of the 2nd.
    commit(d, "src/a.rs", "1\n", "2026-05-01T15:00:00+0000");
    let merged = "2026-05-03T12:00:00+0000";
    at(d, merged, &["merge", "-q", "--no-ff", "-m", "side", "side"]);
    let tip = at(d, merged, &["rev-parse", "HEAD"]);
    if trunk {
        at(d, merged, &["update-ref", "refs/remotes/origin/main", &tip]);
        let head = [
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/main",
        ];
        at(d, merged, &head);
    }
    at(d, merged, &["checkout", "-qb", "feat"]);
    // The change's own commit, backdated: it counts as after every record all the same.
    commit(d, "src/c.rs", "feat\n", "2026-04-01T00:00:00+0000");
    (t, first)
}

#[test]
fn a_dated_record_is_checked_against_the_trunk_before_its_day_began_anywhere() {
    let (t, first) = repo(true);
    let d = t.path();
    let ds = [
        record("a-2nd", "src/a.rs", "", "2026-05-02"),
        record("b-2nd", "src/b.rs", "", "2026-05-02"),
        record("c-2nd", "src/c.rs", "", "2026-05-02"),
        record("d-2nd", "src/d.rs", "", "2026-05-02"),
        record("b-zoned-2nd", "src/b.rs", "", "2026-05-01T23:30:00-02:00"),
        record("b-zoned-1st", "src/b.rs", "", "2026-05-02T01:00:00+05:00"),
        record("a-today", "src/a.rs", "", "2026-05-04"),
        record("a-ahead", "src/a.rs", "", "2026-05-05"),
        record("by-commit", "src/a.rs", &first, ""),
        record("unknown", "src/a.rs", "deadbeef", "2026-05-03"),
        record("unanchored", "src/a.rs", "", "soon"),
    ];
    let refs: Vec<&PriorDecision> = ds.iter().collect();
    let s = scope_check_on(d, &refs, "2026-05-04");
    assert_eq!(ids(&s.unchanged), ["a-today", "b-2nd", "b-zoned-2nd"]);
    assert_eq!(
        ids(&s.missing),
        ["a-ahead", "b-zoned-1st", "unanchored", "unknown"]
    );
    let why = |id: &str| s.why_missing.get(id).map(String::as_str);
    assert_eq!(
        why("a-ahead"),
        Some(
            "the decision date 2026-05-05 is in the future, so no commit precedes it — raised normally"
        )
    );
    assert_eq!(
        why("b-zoned-1st"),
        Some("no commit in this repo before the decision date 2026-05-01 — raised normally")
    );
    // The working tree counts as a change since the day, as it does since a commit.
    std::fs::write(d.join("src/b.rs"), "2\n").unwrap();
    let s = scope_check_on(d, &refs, "2026-05-04");
    assert_eq!(ids(&s.unchanged), ["a-today"]);
}

#[test]
fn with_no_trunk_a_dated_record_anchors_nothing_and_a_commit_still_does() {
    let (t, first) = repo(false);
    let ds = [
        record("dated", "src/b.rs", "", "2026-05-02"),
        record("by-commit", "src/a.rs", &first, ""),
    ];
    let refs: Vec<&PriorDecision> = ds.iter().collect();
    let s = scope_check_on(t.path(), &refs, "2026-05-04");
    assert_eq!(ids(&s.missing), ["dated"]);
    assert!(
        s.why_missing["dated"].starts_with("no trunk could be resolved"),
        "{:?}",
        s.why_missing
    );
    assert!(
        s.unchanged.is_empty(),
        "a.rs changed since the first commit"
    );
}

#[test]
fn with_no_origin_head_the_trunk_is_origin_main() {
    let (t, _) = repo(false);
    let d = t.path();
    let main = at(d, "2026-05-04T00:00:00+0000", &["rev-parse", "main"]);
    at(
        d,
        "2026-05-04T00:00:00+0000",
        &["update-ref", "refs/remotes/origin/main", &main],
    );
    let ds = [record("b-2nd", "src/b.rs", "", "2026-05-02")];
    let refs: Vec<&PriorDecision> = ds.iter().collect();
    let s = scope_check_on(d, &refs, "2026-05-04");
    assert_eq!(ids(&s.unchanged), ["b-2nd"], "{:?}", s.why_missing);
    // The default branch renamed and pruned: origin/HEAD dangles, origin/main still resolves.
    let dangling = [
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/gone",
    ];
    at(d, "2026-05-04T00:00:00+0000", &dangling);
    let s = scope_check_on(d, &refs, "2026-05-04");
    assert_eq!(ids(&s.unchanged), ["b-2nd"], "{:?}", s.why_missing);
}
