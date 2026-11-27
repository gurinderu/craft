use std::collections::BTreeSet;
use std::path::Path;
use std::process::Command;

use super::{quiet_deferrals, take_ledger};
use crate::ledger::{Deferral, LedgerRow};
use crate::rereview::{Chain, Fate};

/// Runs git in `dir`, author and committer dated `date`, its stdout trimmed.
fn git(dir: &Path, date: &str, args: &[&str]) -> String {
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

/// A trunk of two commits, `src/lib.rs` written on 2026-05-01 and `src/other.rs` changed on
/// 2026-05-05, and `HEAD` on it: the first commit.
fn repo() -> (tempfile::TempDir, String) {
    let t = tempfile::tempdir().unwrap();
    let d = t.path();
    let first = "2026-05-01T12:00:00+0000";
    git(d, first, &["init", "-q", "-b", "main"]);
    std::fs::create_dir_all(d.join("src")).unwrap();
    std::fs::write(d.join("src/lib.rs"), "1\n").unwrap();
    std::fs::write(d.join("src/other.rs"), "1\n").unwrap();
    git(d, first, &["add", "."]);
    git(d, first, &["commit", "-qm", "one"]);
    let one = git(d, first, &["rev-parse", "HEAD"]);
    let later = "2026-05-05T12:00:00+0000";
    std::fs::write(d.join("src/other.rs"), "2\n").unwrap();
    git(d, later, &["commit", "-qam", "two"]);
    git(
        d,
        later,
        &["update-ref", "refs/remotes/origin/main", "HEAD"],
    );
    (t, one)
}

fn deferred(file: &str, severity: &str, disposition: &str, d: Option<Deferral>) -> LedgerRow {
    LedgerRow {
        file: file.into(),
        line: 1,
        severity: severity.into(),
        tier: "confirmed".into(),
        disposition: disposition.into(),
        title: "t".into(),
        deferral: d,
        ..LedgerRow::default()
    }
}

fn question(commit: &str, when: &str) -> Deferral {
    Deferral {
        id: "question-abcdef0123".into(),
        commit: commit.into(),
        when: when.into(),
        ..Deferral::default()
    }
}

#[test]
fn a_deferral_is_quiet_by_the_memorys_anchor_and_never_on_a_high_or_another_disposition() {
    let (t, one) = repo();
    let ledger = [
        // By its date: src/lib.rs unchanged since the trunk's last commit before 2026-05-03.
        deferred(
            "src/lib.rs",
            "Medium",
            "deferred",
            Some(question("", "2026-05-03")),
        ),
        // By its date: src/other.rs changed after it.
        deferred(
            "src/other.rs",
            "Medium",
            "deferred",
            Some(question("", "2026-05-03")),
        ),
        deferred("src/lib.rs", "Low", "deferred", Some(question(&one, ""))),
        deferred("src/other.rs", "Low", "deferred", Some(question(&one, ""))),
        deferred(
            "src/lib.rs",
            "High",
            "deferred",
            Some(question("", "2026-05-03")),
        ),
        deferred(
            "src/lib.rs",
            "critical",
            "deferred",
            Some(question(&one, "")),
        ),
        deferred("src/lib.rs", "Medium", "open", Some(question(&one, ""))),
        deferred("src/lib.rs", "Medium", "deferred", None),
        deferred("src/lib.rs", "Medium", "deferred", Some(question("", ""))),
        // No file: the whole tree, which changed since the first commit.
        deferred("", "Medium", "deferred", Some(question(&one, ""))),
        deferred("", "Medium", "deferred", Some(question("", "2026-05-07"))),
    ];
    assert_eq!(
        quiet_deferrals(t.path(), &ledger),
        BTreeSet::from([0, 2, 10])
    );
}

#[test]
fn a_deferred_row_is_carried_as_deferred_by_its_place_among_the_quiet() {
    let rows = vec![
        deferred("a", "Medium", "closed", None),
        deferred("a", "Medium", "deferred", Some(question("c", ""))),
        deferred("a", "Medium", "deferred", Some(question("c", ""))),
    ];
    let mut c = Chain::default();
    take_ledger(&mut c, rows, &BTreeSet::from([2]));
    let fates: Vec<Fate> = c.priors.iter().map(|p| p.fate).collect();
    assert_eq!(fates, [Fate::Pending, Fate::Deferred]);
    assert_eq!(c.tombstones.len(), 1);
}
