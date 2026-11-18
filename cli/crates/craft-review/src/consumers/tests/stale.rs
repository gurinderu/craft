//! When the graph's index is too stale for a review: made before the base, of a root whose
//! history lacks it, or naming no time; git's word kept when the base has none.

use std::path::Path;

use super::{diff_of, fixture};
use crate::consumers::cbm::Index;
use crate::consumers::fresh;

#[test]
fn a_base_outside_the_indexed_root_s_history_is_stale() {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "");
    let base = diff_of(&repo).merge_base;
    let other = fixture(&t.path().join("other"), "// another history\n");
    let index = |root: &Path| Index {
        at: "2099-01-01T00:00:00Z".into(),
        root: root.display().to_string(),
    };
    assert_eq!(fresh::stale(&repo, &base, "p", &index(&repo)), None);
    let why = fresh::stale(&repo, &base, "p", &index(&other)).unwrap();
    assert!(why.contains("is not in the history of"), "{why}");
    assert!(why.contains("cli index_repository"), "{why}");
}

#[test]
fn stale_names_a_bad_time_a_base_with_no_time_and_reads_an_empty_root_as_this_checkout() {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "");
    let base = diff_of(&repo).merge_base;
    let at = |at: &str| Index {
        at: at.into(),
        root: String::new(),
    };
    let why = fresh::stale(&repo, &base, "p", &at("yesterday")).unwrap();
    assert!(why.contains("names no time it was made"), "{why}");
    let why = fresh::stale(&repo, "no-such-ref", "p", &at("2099-01-01T00:00:00Z")).unwrap();
    assert!(
        why.contains("the base no-such-ref has no commit time: git show"),
        "{why}"
    );
    assert_eq!(
        fresh::stale(&repo, &base, "p", &at("2099-01-01T00:00:00Z")),
        None
    );
    let why = fresh::stale(&repo, &base, "p", &at("2000-01-01T00:00:00Z")).unwrap();
    let hint = format!(r#""repo_path":"{}""#, repo.display());
    assert!(why.contains(&hint), "{why}");
}
