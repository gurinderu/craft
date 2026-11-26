use std::path::Path;

use serde_json::{Value, json};

use super::super::record;
use super::{at, commit, ids};
use crate::memory::PriorDecision;
use crate::memory::anchor::pulls;
use crate::memory::priors::scope_check_on;

/// Commits `text` into `file` at `date` with the subject `subject`.
fn landed(dir: &Path, file: &str, text: &str, date: &str, subject: &str) -> String {
    std::fs::write(dir.join(file), text).unwrap();
    at(dir, date, &["add", "."]);
    at(dir, date, &["commit", "-qm", subject]);
    at(dir, date, &["rev-parse", "HEAD"])
}

/// A trunk on `origin` `https://github.com/Owner/Repo.git`: pull request #7 adding `src/m.rs`
/// merged by a merge commit, a side branch's commit naming #7 merged after it, #8 adding `src/s.rs`
/// squashed, #9 adding `src/n.rs` and the scope changed after its merge, then two near misses of
/// #7 — `(#77)` changing `src/keep.rs`, then `Merge pull request #70 from …` changing
/// `src/k2.rs` — and `HEAD` on a branch off it.
fn repo() -> (tempfile::TempDir, String) {
    let t = tempfile::tempdir().unwrap();
    let d = t.path();
    let start = "2026-05-01T08:00:00+0000";
    at(d, start, &["init", "-q", "-b", "main"]);
    let url = "https://github.com/Owner/Repo.git";
    at(d, start, &["remote", "add", "origin", url]);
    std::fs::create_dir_all(d.join("src")).unwrap();
    for f in ["keep", "k2"] {
        std::fs::write(d.join(format!("src/{f}.rs")), "0\n").unwrap();
    }
    let root = commit(d, "src/a.rs", "0\n", start);
    let opened = "2026-05-02T10:00:00+0000";
    at(d, opened, &["checkout", "-qb", "feat7"]);
    landed(d, "src/m.rs", "m\n", opened, "feat: m");
    at(d, opened, &["checkout", "-q", "main"]);
    let merged = "2026-05-02T12:00:00+0000";
    let subject = "Merge pull request #7 from owner/feat7";
    at(
        d,
        merged,
        &["merge", "-q", "--no-ff", "-m", subject, "feat7"],
    );
    // A side branch's commit naming #7, newer than its merge: off the first-parent line, never its merge.
    let side = "2026-05-02T13:00:00+0000";
    at(d, side, &["checkout", "-qb", "side"]);
    landed(d, "src/t.rs", "t\n", side, "docs: t (#7)");
    at(d, side, &["checkout", "-q", "main"]);
    let eleven = "Merge pull request #11 from owner/side";
    at(
        d,
        "2026-05-02T13:30:00+0000",
        &["merge", "-q", "--no-ff", "-m", eleven, "side"],
    );
    landed(
        d,
        "src/s.rs",
        "s\n",
        "2026-05-03T10:00:00+0000",
        "feat: s (#8)",
    );
    let nine = "Merge pull request #9 from owner/feat9";
    landed(d, "src/n.rs", "n\n", "2026-05-03T11:00:00+0000", nine);
    landed(
        d,
        "src/n.rs",
        "n2\n",
        "2026-05-04T10:00:00+0000",
        "chore: n",
    );
    landed(
        d,
        "src/keep.rs",
        "1\n",
        "2026-05-04T11:00:00+0000",
        "fix: k (#77)",
    );
    let seventy = "Merge pull request #70 from owner/x";
    let tip = landed(d, "src/k2.rs", "1\n", "2026-05-04T12:00:00+0000", seventy);
    let late = "2026-05-05T00:00:00+0000";
    at(d, late, &["update-ref", "refs/remotes/origin/main", &tip]);
    let head = [
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/main",
    ];
    at(d, late, &head);
    at(d, late, &["checkout", "-qb", "feat"]);
    (t, root)
}

fn linked(id: &str, scope: &str, when: &str, links: &Value) -> PriorDecision {
    PriorDecision {
        pulls: pulls(links.as_array().unwrap()),
        ..record(id, scope, "", when)
    }
}

fn ours(n: u64) -> String {
    format!("https://github.com/owner/repo/pull/{n}")
}

#[test]
fn a_record_linking_its_pull_request_is_checked_since_that_requests_merge_on_the_trunk() {
    let (t, root) = repo();
    let d = t.path();
    let other = "https://github.com/someone/else/pull/7";
    let ds = [
        linked(
            "pr7",
            "src/m.rs",
            "2026-05-02",
            &json!([format!("{}#r1", ours(7))]),
        ),
        record("day7", "src/m.rs", "", "2026-05-02"),
        linked(
            "pr8",
            "src/s.rs",
            "2026-05-03",
            &json!(["https://GitHub.com/Owner/Repo/pull/8/files"]),
        ),
        linked("pr9", "src/n.rs", "2026-05-03", &json!([ours(9)])),
        linked("other", "src/m.rs", "2026-05-02", &json!([other])),
        linked("unmerged", "src/a.rs", "2026-05-02", &json!([ours(10)])),
        linked(
            "unmerged-ahead",
            "src/a.rs",
            "2099-01-01",
            &json!([ours(10)]),
        ),
        linked("unmerged-undated", "src/a.rs", "", &json!([ours(10)])),
        linked("undated", "src/m.rs", "", &json!([ours(7)])),
        linked(
            "first-ours",
            "src/s.rs",
            "",
            &json!([other, ours(8), ours(7)]),
        ),
        linked("near77", "src/keep.rs", "", &json!([ours(7)])),
        linked("near70", "src/k2.rs", "", &json!([ours(7)])),
        linked("side7", "src/t.rs", "", &json!([ours(7)])),
        PriorDecision {
            pulls: pulls(json!([ours(7)]).as_array().unwrap()),
            ..record("by-commit", "src/m.rs", &root, "")
        },
    ];
    let refs: Vec<&PriorDecision> = ds.iter().collect();
    let s = scope_check_on(d, &refs, "2026-05-05");
    assert_eq!(
        ids(&s.unchanged),
        ["first-ours", "pr7", "pr8", "undated", "unmerged"],
        "{:?}",
        s.why_missing
    );
    let merged: Vec<(&str, u64)> = s.merged.iter().map(|(k, v)| (k.as_str(), *v)).collect();
    assert_eq!(
        merged,
        [
            ("first-ours", 8),
            ("near70", 7),
            ("near77", 7),
            ("pr7", 7),
            ("pr8", 8),
            ("pr9", 9),
            ("side7", 7),
            ("undated", 7)
        ]
    );
    assert_eq!(ids(&s.missing), ["unmerged-ahead", "unmerged-undated"]);
    assert_eq!(
        s.why_missing["unmerged-ahead"],
        "the decision date 2099-01-01 is in the future, so no commit precedes it — raised normally"
    );
    assert_eq!(
        s.why_missing["unmerged-undated"],
        "no pull request of this repository it links is merged on the trunk, and it records no \
         date — raised normally"
    );
    // The working tree counts as a change since the merge, as it does since a commit.
    std::fs::write(d.join("src/s.rs"), "edited\n").unwrap();
    let s = scope_check_on(d, &refs, "2026-05-05");
    assert_eq!(ids(&s.unchanged), ["pr7", "undated", "unmerged"]);
}

#[test]
fn a_record_linking_a_pull_request_no_trunk_or_origin_places_falls_back_to_its_date() {
    let (t, _) = repo();
    let d = t.path();
    let ds = [
        linked("pr7", "src/m.rs", "2026-05-02", &json!([ours(7)])),
        linked("pr7-a", "src/a.rs", "2026-05-02", &json!([ours(7)])),
    ];
    let refs: Vec<&PriorDecision> = ds.iter().collect();
    let late = "2026-05-05T00:00:00+0000";
    // Origin another repository: the date's base, the root, before m.rs was added.
    at(
        d,
        late,
        &[
            "remote",
            "set-url",
            "origin",
            "https://gitlab.com/owner/repo",
        ],
    );
    let s = scope_check_on(d, &refs, "2026-05-05");
    assert!(s.merged.is_empty(), "{:?}", s.merged);
    assert_eq!(ids(&s.unchanged), ["pr7-a"]);
    // Origin this repository but no trunk: nothing to find the merge on, nor the date's base.
    at(
        d,
        late,
        &[
            "remote",
            "set-url",
            "origin",
            "git@github.com:owner/repo.git",
        ],
    );
    at(
        d,
        late,
        &["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"],
    );
    at(d, late, &["update-ref", "-d", "refs/remotes/origin/main"]);
    let s = scope_check_on(d, &refs, "2026-05-05");
    assert!(s.merged.is_empty(), "{:?}", s.merged);
    assert_eq!(ids(&s.missing), ["pr7", "pr7-a"]);
    assert!(s.why_missing["pr7"].starts_with("no trunk could be resolved"));
}

#[test]
fn the_merge_of_a_pull_request_is_the_newest_first_parent_commit_whose_subject_names_it() {
    let (t, _) = repo();
    let d = t.path();
    let log = |n| crate::git::merge_of(d, "origin/main", n).unwrap();
    let subject = |c: Option<String>| {
        at(
            d,
            "2026-05-05T00:00:00+0000",
            &["log", "-1", "--format=%s", &c.unwrap()],
        )
    };
    assert_eq!(subject(log(7)), "Merge pull request #7 from owner/feat7");
    assert_eq!(subject(log(8)), "feat: s (#8)");
    assert_eq!(subject(log(77)), "fix: k (#77)");
    assert_eq!(log(10), None);
    // The branch's own commit is off the first-parent line.
    assert_eq!(crate::git::merge_of(d, "feat7", 7).unwrap(), None);
    let option = crate::git::merge_of(d, "-n", 7).unwrap_err();
    assert!(
        matches!(option, crate::git::GitError::NotACommit { .. }),
        "{option}"
    );
    crate::git::merge_of(d, "nosuchref", 7).unwrap_err();
}

#[test]
fn a_finding_in_a_merged_pull_requests_code_is_raised_naming_that_merge_when_its_scope_changed() {
    let (t, _) = repo();
    let d = t.path();
    let ds = [PriorDecision {
        title: "defect n".into(),
        reason: "r".into(),
        line: 10,
        lens: "errors".into(),
        ..linked("pr9", "src/n.rs", "2026-05-03", &json!([ours(9)]))
    }];
    let findings = vec![
        json!({"severity": "Medium", "title": "defect n", "file": "src/n.rs", "line": 10, "why": "w", "source": "errors", "tier": "confirmed"}),
    ];
    let check = |ds: &[&PriorDecision]| scope_check_on(d, ds, "2026-05-05");
    let prepared = crate::memory::apply::prepare(&findings, &ds, &check, &[]);
    // As a run's state keeps it between the step that asks the judge and the one that reads it.
    let kept = serde_json::to_value(prepared.to_keep()).unwrap();
    assert_eq!(kept["merged"], json!({"pr9": 9}));
    let kept = serde_json::from_value(kept).unwrap();
    let asked = crate::memory::apply::prepare_asked(&findings, &ds, &kept, &[]);
    for p in [&prepared, &asked] {
        let out = crate::memory::apply::apply(findings.clone(), p, None, "why");
        let why = out.kept[0]["why"].as_str().unwrap();
        assert!(
            why.ends_with("raised again: the code in src/n.rs changed since the merge of PR #9 (or that could not be checked)."),
            "{why}"
        );
    }
    let none = serde_json::to_value(crate::memory::MatchAsked::default()).unwrap();
    assert!(none.get("merged").is_none(), "{none}");
}

/// A later commit citing a pull request is never its merge: the merge commit wins over a citing
/// squash-style subject, and among squash-style subjects the oldest — the squash itself — wins.
#[test]
fn a_later_commit_citing_a_pull_request_is_not_its_merge() {
    let t = tempfile::tempdir().unwrap();
    let d = t.path();
    let start = "2026-05-01T08:00:00+0000";
    at(d, start, &["init", "-q", "-b", "main"]);
    at(
        d,
        start,
        &["remote", "add", "origin", "git@github.com:owner/repo.git"],
    );
    std::fs::create_dir_all(d.join("src")).unwrap();
    commit(d, "src/a.rs", "0\n", start);
    landed(
        d,
        "src/q.rs",
        "q\n",
        "2026-05-02T10:00:00+0000",
        "feat: q (#12)",
    );
    landed(
        d,
        "src/q.rs",
        "q2\n",
        "2026-05-03T10:00:00+0000",
        "fix: q again (#12)",
    );
    let merge = "Merge pull request #13 from owner/r";
    landed(d, "src/r.rs", "r\n", "2026-05-02T11:00:00+0000", merge);
    let tip = landed(
        d,
        "src/r.rs",
        "r2\n",
        "2026-05-03T11:00:00+0000",
        "docs: r (#13)",
    );
    let late = "2026-05-04T00:00:00+0000";
    at(d, late, &["update-ref", "refs/remotes/origin/main", &tip]);
    let ds = [
        linked("pr12", "src/q.rs", "", &json!([ours(12)])),
        linked("pr13", "src/r.rs", "", &json!([ours(13)])),
    ];
    let refs: Vec<&PriorDecision> = ds.iter().collect();
    let s = scope_check_on(d, &refs, "2026-05-04");
    assert!(ids(&s.unchanged).is_empty(), "{:?}", s.merged);
}
