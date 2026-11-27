//! A record linking its pull request: unchanged only when its scope also did not change on the
//! trunk outside the pull request before the merge — where the request's branch lacked it, or after
//! the record's decision date (realm @nick/craft, node #682).

use serde_json::json;

use super::super::record;
use super::{at, ids};
use crate::memory::PriorDecision;
use crate::memory::anchor::{Base, pulls};
use crate::memory::priors::scope_check_on;

mod shallow;

/// How pull request #7 reached the trunk.
#[derive(Clone, Copy)]
pub(in crate::memory) enum Landed {
    /// A merge commit of its branch as it was opened, before #8.
    Stale,
    /// A merge commit of its branch rebased onto #8.
    Rebased,
    /// A squash: one parent, its message's body a line `parent of #9`.
    Squashed,
}

/// Commits `text` into `file` at `date` with the subject `subject`.
fn landed(dir: &std::path::Path, file: &str, text: &str, date: &str, subject: &str) {
    std::fs::write(dir.join(file), text).unwrap();
    at(dir, date, &["add", "."]);
    at(dir, date, &["commit", "-qm", subject]);
}

/// A trunk on origin `git@github.com:owner/repo.git`: its root on 2026-05-01 08:00 UTC, before
/// 2026-05-02 began anywhere; #7 opened off it at 09:00 changing `src/p.rs`; #8 squashed on
/// 2026-05-02 09:00 UTC, before 2026-05-03 began anywhere, changing `src/a.rs`; then #7 landing on
/// 2026-05-04 as `how` says.
pub(in crate::memory) fn repo(how: Landed) -> tempfile::TempDir {
    let t = tempfile::tempdir().unwrap();
    let d = t.path();
    let start = "2026-05-01T08:00:00+0000";
    at(d, start, &["init", "-q", "-b", "main"]);
    let url = "git@github.com:owner/repo.git";
    at(d, start, &["remote", "add", "origin", url]);
    std::fs::create_dir_all(d.join("src")).unwrap();
    std::fs::write(d.join("src/a.rs"), "a\n").unwrap();
    landed(d, "src/p.rs", "p\n", start, "root");
    let opened = "2026-05-01T09:00:00+0000";
    at(d, opened, &["checkout", "-qb", "feat7"]);
    landed(d, "src/p.rs", "p7\n", opened, "feat: p");
    at(d, opened, &["checkout", "-q", "main"]);
    let eight = "2026-05-02T09:00:00+0000";
    landed(d, "src/a.rs", "a8\n", eight, "fix: a (#8)");
    let merged = "2026-05-04T12:00:00+0000";
    if matches!(how, Landed::Rebased) {
        let rebased = "2026-05-02T10:00:00+0000";
        at(d, rebased, &["checkout", "-q", "feat7"]);
        at(d, rebased, &["rebase", "-q", "main"]);
        at(d, rebased, &["checkout", "-q", "main"]);
    }
    if matches!(how, Landed::Squashed) {
        at(d, merged, &["merge", "-q", "--squash", "feat7"]);
        // A body line spelled like a parent header: only the header names parents.
        let message = ["commit", "-q", "-m", "feat: p (#7)", "-m", "parent of #9"];
        at(d, merged, &message);
    } else {
        let subject = "Merge pull request #7 from owner/feat7";
        let merge = ["merge", "-q", "--no-ff", "-m", subject, "feat7"];
        at(d, merged, &merge);
    }
    at(
        d,
        merged,
        &["update-ref", "refs/remotes/origin/main", "HEAD"],
    );
    t
}

fn linked(id: &str, scope: &str, when: &str) -> PriorDecision {
    PriorDecision {
        pulls: pulls(&[json!("https://github.com/owner/repo/pull/7")]),
        ..record(id, scope, "", when)
    }
}

/// The records, `a-ahead` right after `a-early`, whose date's base a line run after it must not
/// keep.
fn records() -> Vec<PriorDecision> {
    vec![
        linked("a-early", "src/a.rs", "2026-05-02"),
        linked("a-ahead", "src/a.rs", "2099-01-01"),
        linked("a-dated", "src/a.rs", "2026-05-03"),
        linked("a-undated", "src/a.rs", ""),
        linked("p-dated", "src/p.rs", "2026-05-03"),
        linked("p-after", "src/p.rs", "2026-05-10"),
        linked("a-before-root", "src/a.rs", "2026-04-01"),
    ]
}

/// What the scope check of [`records`] names changed outside the pull request and unchanged.
fn seen(how: Landed) -> (Vec<String>, Vec<String>) {
    let t = repo(how);
    let ds = records();
    let refs: Vec<&PriorDecision> = ds.iter().collect();
    let s = scope_check_on(t.path(), &refs, "2026-05-11");
    assert_eq!(ids(&s.missing), ["a-before-root"]);
    assert_eq!(
        s.why_missing["a-before-root"],
        "no commit in this repo before the decision date 2026-04-01 — raised normally"
    );
    assert_eq!(s.merged.len(), ds.len() - 1, "{:?}", s.merged);
    let own =
        |set: &std::collections::BTreeSet<String>| ids(set).into_iter().map(String::from).collect();
    (own(&s.between), own(&s.unchanged))
}

#[test]
fn a_stale_branchs_merge_is_raised_when_the_trunk_changed_its_scope_where_the_branch_lacked_it() {
    let (between, unchanged) = seen(Landed::Stale);
    assert_eq!(between, ["a-ahead", "a-dated", "a-early", "a-undated"]);
    assert_eq!(unchanged, ["p-after", "p-dated"]);
}

#[test]
fn a_rebased_branchs_merge_is_raised_only_for_a_trunk_change_after_the_decision_date() {
    let (between, unchanged) = seen(Landed::Rebased);
    assert_eq!(between, ["a-early"]);
    assert_eq!(
        unchanged,
        ["a-ahead", "a-dated", "a-undated", "p-after", "p-dated"]
    );
}

#[test]
fn a_squash_has_the_decision_dates_window_as_its_only_bound() {
    let (between, unchanged) = seen(Landed::Squashed);
    assert_eq!(between, ["a-early"]);
    assert_eq!(
        unchanged,
        ["a-ahead", "a-dated", "a-undated", "p-after", "p-dated"]
    );
}

#[test]
fn a_scope_changed_since_the_merge_too_is_said_changed_since_it() {
    let t = repo(Landed::Stale);
    let d = t.path();
    std::fs::write(d.join("src/a.rs"), "edited\n").unwrap();
    let ds = records();
    let refs: Vec<&PriorDecision> = ds.iter().collect();
    let s = scope_check_on(d, &refs, "2026-05-11");
    assert!(s.between.is_empty(), "{:?}", s.between);
    assert_eq!(ids(&s.unchanged), ["p-after", "p-dated"]);
}

#[test]
fn a_finding_whose_scope_the_trunk_changed_outside_the_pull_request_is_raised_naming_it() {
    let t = repo(Landed::Stale);
    let d = t.path();
    let ds = [PriorDecision {
        title: "defect a".into(),
        reason: "r".into(),
        line: 10,
        lens: "errors".into(),
        ..linked("a-dated", "src/a.rs", "2026-05-03")
    }];
    let findings = vec![
        json!({"severity": "Medium", "title": "defect a", "file": "src/a.rs", "line": 10, "why": "w", "source": "errors", "tier": "confirmed"}),
    ];
    let check = |ds: &[&PriorDecision]| scope_check_on(d, ds, "2026-05-11");
    let prepared = crate::memory::apply::prepare(&findings, &ds, &check, &[]);
    // As a run's state keeps it between the step that asks the judge and the one that reads it.
    let kept = serde_json::to_value(prepared.to_keep()).unwrap();
    assert_eq!(kept["between"], json!(["a-dated"]));
    let kept = serde_json::from_value(kept).unwrap();
    let asked = crate::memory::apply::prepare_asked(&findings, &ds, &kept, &[]);
    for p in [&prepared, &asked] {
        let out = crate::memory::apply::apply(findings.clone(), p, None, "why");
        let why = out.kept[0]["why"].as_str().unwrap();
        assert!(
            why.ends_with(
                "raised again: the code in src/a.rs changed on the trunk outside the pull request \
                 before the merge of PR #7 (or that could not be checked)."
            ),
            "{why}"
        );
    }
    let none = serde_json::to_value(crate::memory::MatchAsked::default()).unwrap();
    assert!(none.get("between").is_none(), "{none}");
}

#[test]
fn a_merges_second_parent_is_its_branch_and_a_squash_or_root_has_none() {
    let late = "2026-05-11T00:00:00+0000";
    let t = repo(Landed::Stale);
    let d = t.path();
    let branch = at(d, late, &["rev-parse", "feat7"]);
    let parent = |c: &str| crate::git::second_parent(d, c);
    assert_eq!(parent("HEAD").unwrap(), Some(branch));
    assert_eq!(parent("HEAD^1").unwrap(), None);
    let root = at(d, late, &["rev-list", "--max-parents=0", "HEAD"]);
    assert_eq!(parent(&root).unwrap(), None);
    parent("nosuchref").unwrap_err();
    let option = parent("--all").unwrap_err();
    assert!(
        matches!(option, crate::git::GitError::NotACommit { .. }),
        "{option}"
    );
    let squashed = repo(Landed::Squashed);
    let tip = crate::git::second_parent(squashed.path(), "HEAD");
    assert_eq!(tip.unwrap(), None);
}

#[test]
fn a_merge_whose_parents_git_cannot_read_is_changed_outside_it_and_a_commit_has_no_outside() {
    let t = repo(Landed::Stale);
    let d = t.path();
    let unknown = Base {
        commit: "0".repeat(40),
        pull: Some(7),
        dated: None,
    };
    assert!(!unknown.unchanged_outside(d, "src/p.rs"));
    let commit = Base {
        pull: None,
        ..unknown
    };
    assert!(commit.unchanged_outside(d, "src/p.rs"));
}

#[test]
fn a_base_spelled_as_an_option_is_never_handed_to_git_diff() {
    let t = repo(Landed::Stale);
    let d = t.path();
    let merge = at(d, "2026-05-11T00:00:00+0000", &["rev-parse", "HEAD"]);
    let root = at(
        d,
        "2026-05-11T00:00:00+0000",
        &["rev-list", "--max-parents=0", "HEAD"],
    );
    assert!(crate::git::unchanged_before_merge(
        d, &root, &merge, "src/p.rs"
    ));
    let out = d.join("out");
    let option = format!("--output={}", out.display());
    assert!(!crate::git::unchanged_before_merge(
        d, &option, &merge, "src/p.rs"
    ));
    assert!(!out.exists());
}
