//! A record linking its pull request and dated: unchanged only when its scope also did not change
//! on the trunk between its decision date and the merge (realm @nick/craft, node #682).

use serde_json::json;

use super::super::record;
use super::{at, ids};
use crate::memory::PriorDecision;
use crate::memory::anchor::pulls;
use crate::memory::priors::scope_check_on;

/// Commits `text` into `file` at `date` with the subject `subject`.
fn landed(dir: &std::path::Path, file: &str, text: &str, date: &str, subject: &str) {
    std::fs::write(dir.join(file), text).unwrap();
    at(dir, date, &["add", "."]);
    at(dir, date, &["commit", "-qm", subject]);
}

/// A trunk on origin `git@github.com:owner/repo.git`: its root on 2026-05-01 08:00 UTC, before
/// 2026-05-02 began anywhere; #8 squashed on the 2nd changing `src/w.rs`; then #7, opened before
/// #8 landed and changing `src/p.rs`, merged after it by a merge commit.
fn repo() -> tempfile::TempDir {
    let t = tempfile::tempdir().unwrap();
    let d = t.path();
    let start = "2026-05-01T08:00:00+0000";
    at(d, start, &["init", "-q", "-b", "main"]);
    let url = "git@github.com:owner/repo.git";
    at(d, start, &["remote", "add", "origin", url]);
    std::fs::create_dir_all(d.join("src")).unwrap();
    std::fs::write(d.join("src/w.rs"), "w\n").unwrap();
    landed(d, "src/p.rs", "p\n", start, "root");
    let opened = "2026-05-02T08:00:00+0000";
    at(d, opened, &["checkout", "-qb", "feat7"]);
    landed(d, "src/p.rs", "p7\n", opened, "feat: p");
    at(d, opened, &["checkout", "-q", "main"]);
    landed(
        d,
        "src/w.rs",
        "w8\n",
        "2026-05-02T09:00:00+0000",
        "fix: w (#8)",
    );
    let merged = "2026-05-02T12:00:00+0000";
    let subject = "Merge pull request #7 from owner/feat7";
    at(
        d,
        merged,
        &["merge", "-q", "--no-ff", "-m", subject, "feat7"],
    );
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

#[test]
fn a_dated_record_linking_its_pull_request_is_raised_when_the_trunk_changed_its_scope_before_the_merge()
 {
    let t = repo();
    let d = t.path();
    let ds = [
        linked("w-dated", "src/w.rs", "2026-05-02"),
        linked("p-dated", "src/p.rs", "2026-05-02"),
        linked("w-undated", "src/w.rs", ""),
        linked("w-after", "src/w.rs", "2026-05-10"),
        linked("w-before-root", "src/w.rs", "2026-04-01"),
        linked("w-ahead", "src/w.rs", "2099-01-01"),
    ];
    let refs: Vec<&PriorDecision> = ds.iter().collect();
    let s = scope_check_on(d, &refs, "2026-05-11");
    assert_eq!(ids(&s.between), ["w-dated"], "{:?}", s.why_missing);
    assert_eq!(
        ids(&s.unchanged),
        [
            "p-dated",
            "w-after",
            "w-ahead",
            "w-before-root",
            "w-undated"
        ]
    );
    assert!(s.missing.is_empty(), "{:?}", s.why_missing);
    assert_eq!(s.merged.len(), ds.len());
    // Changed since the merge too: said as a change since the merge, not before it.
    std::fs::write(d.join("src/w.rs"), "edited\n").unwrap();
    let s = scope_check_on(d, &refs, "2026-05-11");
    assert!(s.between.is_empty(), "{:?}", s.between);
    assert_eq!(ids(&s.unchanged), ["p-dated"]);
}

#[test]
fn a_finding_whose_scope_the_trunk_changed_before_the_merge_is_raised_naming_both() {
    let t = repo();
    let d = t.path();
    let ds = [PriorDecision {
        title: "defect w".into(),
        reason: "r".into(),
        line: 10,
        lens: "errors".into(),
        ..linked("w-dated", "src/w.rs", "2026-05-02")
    }];
    let findings = vec![
        json!({"severity": "Medium", "title": "defect w", "file": "src/w.rs", "line": 10, "why": "w", "source": "errors", "tier": "confirmed"}),
    ];
    let check = |ds: &[&PriorDecision]| scope_check_on(d, ds, "2026-05-11");
    let prepared = crate::memory::apply::prepare(&findings, &ds, &check, &[]);
    // As a run's state keeps it between the step that asks the judge and the one that reads it.
    let kept = serde_json::to_value(prepared.to_keep()).unwrap();
    assert_eq!(kept["between"], json!(["w-dated"]));
    let kept = serde_json::from_value(kept).unwrap();
    let asked = crate::memory::apply::prepare_asked(&findings, &ds, &kept, &[]);
    for p in [&prepared, &asked] {
        let out = crate::memory::apply::apply(findings.clone(), p, None, "why");
        let why = out.kept[0]["why"].as_str().unwrap();
        assert!(
            why.ends_with(
                "raised again: the code in src/w.rs changed on the trunk between the decision \
                 date 2026-05-02 and the merge of PR #7 (or that could not be checked)."
            ),
            "{why}"
        );
    }
    let none = serde_json::to_value(crate::memory::MatchAsked::default()).unwrap();
    assert!(none.get("between").is_none(), "{none}");
}

#[test]
fn a_base_spelled_as_an_option_is_never_handed_to_git_diff() {
    let t = repo();
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
