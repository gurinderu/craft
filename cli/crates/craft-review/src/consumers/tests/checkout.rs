//! Only an index of the very checkout under review is asked (realm @nick/craft, node #529): a
//! sibling checkout's root after craft's own index of it means another review moved the project,
//! and a change with no symbol to ask about indexes nothing.

use super::reindex::{INDEXED, ROW, graph_of_own, reindexed};
use super::{diff_of, fixture, git, repo_root};
use crate::consumers::{NAME_SEARCH, build};

#[test]
fn a_project_moved_back_to_the_main_checkout_after_the_index_is_not_asked() {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "");
    let wt = t.path().join("wt");
    git(
        &repo,
        &[
            "worktree",
            "add",
            "-q",
            "--detach",
            &wt.display().to_string(),
        ],
    );
    // Indexed at the worktree, the project then names the main checkout: another review's move.
    let g = graph_of_own(
        t.path(),
        ("/elsewhere", &repo_root(t.path())),
        INDEXED,
        ROW,
        false,
    );
    let c = build(&wt, &diff_of(&wt), Ok(g));
    assert!(reindexed(t.path()).contains(r#""name":"craft-review-"#));
    assert_eq!(c.sources, vec![NAME_SEARCH], "{c:?}");
    assert!(
        c.graph_skipped.contains("not of this checkout")
            && c.graph_skipped.contains("another review moved it"),
        "{}",
        c.graph_skipped
    );
    assert!(!t.path().join("queries").exists(), "the graph was asked");
}

#[test]
fn a_change_with_no_symbol_indexes_nothing_and_says_so() {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "");
    let g = graph_of_own(
        t.path(),
        ("/elsewhere", &repo_root(t.path())),
        INDEXED,
        ROW,
        false,
    );
    let none = crate::git::read_diff(&repo, Some("HEAD"), None).unwrap();
    let c = build(&repo, &none, Ok(g));
    assert!(
        reindexed(t.path()).is_empty(),
        "indexed: {}",
        reindexed(t.path())
    );
    assert!(
        !t.path().join("status-calls").exists(),
        "the graph was asked"
    );
    assert!(c.graph_skipped.contains("no symbol to ask"), "{c:?}");
}
