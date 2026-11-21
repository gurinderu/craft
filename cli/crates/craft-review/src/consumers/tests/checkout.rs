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

#[test]
fn a_change_with_no_symbol_is_indexed_for_the_metrics_lenses_alone_and_lists_no_graph() {
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
    let c = crate::consumers::build_for_metrics(&repo, &none, Ok(g));
    assert_eq!(
        reindexed(t.path()).lines().count(),
        1,
        "{}",
        reindexed(t.path())
    );
    assert!(c.graph_indexed, "{c:?}");
    assert_eq!(c.sources, vec![NAME_SEARCH], "{c:?}");
}

#[test]
fn a_profile_naming_no_graph_has_one_found_answering_on_the_path() {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "");
    let projects = t.path().join("projects");
    let g = graph_of_own(
        t.path(),
        ("/elsewhere", &repo_root(t.path())),
        INDEXED,
        ROW,
        false,
    );
    let found = crate::consumers::graph_found(Some(&projects), &repo, &g.tool).unwrap();
    assert_eq!(found.tool, g.tool);
    let missing = t.path().join("no-such-cbm").display().to_string();
    let why = crate::consumers::graph_found(Some(&projects), &repo, &missing)
        .unwrap_err()
        .to_string();
    assert!(
        why.contains("names no code graph") && why.contains("did not answer"),
        "{why}"
    );
}
