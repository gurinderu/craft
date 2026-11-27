use std::path::Path;

use super::unchanged_on;
use crate::ledger::Deferral;
use crate::memory::Pull;
use crate::memory::anchor::tests::repo::between::{self, Landed};
use crate::memory::anchor::tests::repo::{at, commit, repo};

const TODAY: &str = "2026-05-04";

fn deferral(commit: &str, when: &str, link: &str, pulls: &[u64]) -> Deferral {
    Deferral {
        id: "question-abcdef0123".into(),
        commit: commit.into(),
        when: when.into(),
        link: link.into(),
        pulls: pulls
            .iter()
            .map(|&number| Pull {
                repo: "owner/repo".into(),
                number,
            })
            .collect(),
        ..Deferral::default()
    }
}

fn check(dir: &Path, rows: &[(Deferral, &str)]) -> Vec<bool> {
    let rows: Vec<(&Deferral, &str)> = rows.iter().map(|(d, f)| (d, *f)).collect();
    unchanged_on(dir, &rows, TODAY)
}

#[test]
fn a_deferral_is_unchanged_by_its_commit_else_its_date_and_never_without_an_anchor() {
    let (t, first) = repo(true);
    let d = t.path();
    let head = at(d, "2026-05-04T00:00:00+0000", &["rev-parse", "HEAD"]);
    let rows = [
        // src/b.rs last changed before the 2nd began anywhere; src/a.rs after.
        (deferral("", "2026-05-02", "", &[]), "src/b.rs"),
        (deferral("", "2026-05-02", "", &[]), "src/a.rs"),
        // The change's own file counts as after the date, its commit backdated or not.
        (deferral("", "2026-05-02", "", &[]), "src/c.rs"),
        (deferral(&head, "", "", &[]), "src/b.rs"),
        (deferral(&first, "", "", &[]), "src/b.rs"),
        // A commit wins over a date that would have held.
        (deferral(&first, "2026-05-02", "", &[]), "src/b.rs"),
        (deferral("deadbeef", "", "", &[]), "src/b.rs"),
        (deferral("", "2026-05-05", "", &[]), "src/b.rs"),
        (deferral("", "", "", &[]), "src/b.rs"),
        (
            deferral("", "soon", "https://example.com/q", &[]),
            "src/b.rs",
        ),
    ];
    assert_eq!(
        check(d, &rows),
        [
            true, false, false, true, false, false, false, false, false, false
        ]
    );
    // The working tree counts as a change since the anchor.
    std::fs::write(d.join("src/b.rs"), "2\n").unwrap();
    assert_eq!(check(d, &rows[..1]), [false]);
    assert_eq!(check(d, &rows[3..4]), [false]);
}

/// A trunk on origin `https://github.com/Owner/Repo.git` that merged pull request #7, adding
/// `src/m.rs`, and `HEAD` on a branch off it.
fn merged() -> tempfile::TempDir {
    let t = tempfile::tempdir().unwrap();
    let d = t.path();
    let start = "2026-05-01T08:00:00+0000";
    at(d, start, &["init", "-q", "-b", "main"]);
    at(
        d,
        start,
        &[
            "remote",
            "add",
            "origin",
            "https://github.com/Owner/Repo.git",
        ],
    );
    std::fs::create_dir_all(d.join("src")).unwrap();
    commit(d, "src/a.rs", "0\n", start);
    let opened = "2026-05-02T10:00:00+0000";
    at(d, opened, &["checkout", "-qb", "feat7"]);
    commit(d, "src/m.rs", "m\n", opened);
    at(d, opened, &["checkout", "-q", "main"]);
    let when = "2026-05-02T12:00:00+0000";
    let subject = "Merge pull request #7 from owner/feat7";
    at(d, when, &["merge", "-q", "--no-ff", "-m", subject, "feat7"]);
    let tip = at(d, when, &["rev-parse", "HEAD"]);
    at(d, when, &["update-ref", "refs/remotes/origin/main", &tip]);
    at(d, when, &["checkout", "-qb", "feat"]);
    t
}

#[test]
fn a_deferral_linking_a_merged_pull_request_is_unchanged_since_its_merge() {
    let t = merged();
    let d = t.path();
    let pr = "https://github.com/owner/repo/pull/7";
    let rows = [
        (
            deferral("", "", "https://github.com/owner/repo/issues/3", &[7]),
            "src/m.rs",
        ),
        // A row written before its pull requests were carried: its link names the request.
        (deferral("", "", pr, &[]), "src/m.rs"),
        // Its link names an issue and it carries no pull request: nothing anchors it.
        (
            deferral("", "", "https://github.com/owner/repo/issues/3", &[]),
            "src/m.rs",
        ),
        // A request this trunk never merged, and no date to fall back on.
        (deferral("", "", "", &[8]), "src/m.rs"),
    ];
    assert_eq!(check(d, &rows), [true, true, false, false]);
    commit(d, "src/m.rs", "m2\n", "2026-05-03T10:00:00+0000");
    assert_eq!(check(d, &rows[..2]), [false, false]);
}

#[test]
fn a_deferral_is_checked_by_its_questions_scope_and_a_row_without_one_by_its_file() {
    let (t, _) = repo(true);
    let d = t.path();
    let head = at(d, "2026-05-04T00:00:00+0000", &["rev-parse", "HEAD"]);
    // A question on the folder, set aside on one file in it.
    let scoped = Deferral {
        scope: "src".into(),
        ..deferral(&head, "", "", &[])
    };
    let rows = [
        (scoped, "src/b.rs"),
        // A row written before its scope was carried: its file alone.
        (deferral(&head, "", "", &[]), "src/b.rs"),
    ];
    assert_eq!(check(d, &rows), [true, true]);
    // A sibling in the question's folder changed since its anchor; the row's file did not.
    commit(d, "src/a.rs", "2\n", "2026-05-04T01:00:00+0000");
    assert_eq!(check(d, &rows), [false, true]);
}

#[test]
fn a_deferral_whose_scope_the_trunk_changed_outside_its_pull_request_before_the_merge_is_not_quiet()
{
    // #7 opened off the root changing src/p.rs, #8 changed src/a.rs on the trunk, then #7's stale
    // branch merged: src/a.rs is unchanged since the merge, but changed outside #7 before it.
    let t = between::repo(Landed::Stale);
    let d = t.path();
    let rows = [
        (deferral("", "", "", &[7]), "src/a.rs"),
        (deferral("", "", "", &[7]), "src/p.rs"),
    ];
    assert_eq!(check(d, &rows), [false, true]);
}
