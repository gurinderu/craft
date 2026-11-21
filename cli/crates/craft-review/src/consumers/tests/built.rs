//! A list that could not be built says why in both outputs; a hunk that only removes lines names
//! the item it removes them from; the diff is read from the recorded merge-base.

use super::{diff_of, fixture, git, no_graph};
use crate::consumers::{Consumers, build, lens_block, of_checkout, section};

/// Fails unless both outputs carry `why`.
#[track_caller]
fn said_in_both(c: &Consumers, why: &str) {
    let (s, block) = (section(c), lens_block(c).unwrap());
    assert!(s.contains(why), "{s:?}");
    assert!(block.contains(why), "{block:?}");
    assert!(
        block.contains("No consumers list could be built"),
        "{block}"
    );
}

#[test]
fn a_diff_that_cannot_be_read_is_said_not_read_as_no_symbol() {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "");
    let mut diff = diff_of(&repo);
    diff.merge_base = "0000000000000000000000000000000000000000".into();
    let c = build(&repo, &diff, no_graph());
    assert!(
        c.failed.starts_with("the change's diff could not be read"),
        "{c:?}"
    );
    said_in_both(&c, "the change's diff could not be read");
}

#[test]
fn a_checkout_whose_top_cannot_be_read_is_said() {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "");
    let diff = diff_of(&repo);
    let elsewhere = t.path().join("not-a-repo");
    std::fs::create_dir_all(&elsewhere).unwrap();
    let c = of_checkout(
        &elsewhere,
        (None, false),
        &diff,
        &crate::cancel::Cancel::default(),
    );
    said_in_both(&c, "the checkout's top could not be read");
}

#[test]
fn a_stopped_build_is_said_in_both_outputs() {
    said_in_both(
        &Consumers::failed("the consumers list stopped unexpectedly"),
        "the consumers list stopped unexpectedly",
    );
}

#[test]
fn the_diff_is_read_from_the_recorded_merge_base_not_the_base_ref() {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "");
    let diff = diff_of(&repo);
    // The base ref moves after the run recorded its merge-base.
    git(&repo, &["branch", "-f", "base", "HEAD"]);
    let c = build(&repo, &diff, no_graph());
    assert!(c.failed.is_empty(), "{}", c.failed);
    assert!(
        c.symbols.iter().any(|s| s.name == "k8s_rule_to_api"),
        "{c:?}"
    );
}

const GUARDED: &str = "use std::fmt;\n\npub fn guarded_call(x: u8) -> u8 {\n    if x > 9 {\n        return 0;\n    }\n    x\n}\n\npub fn removed_whole() -> u8 {\n    1\n}\n\npub fn last() -> u8 {\n    2\n}\n";

#[test]
fn a_hunk_that_only_removes_lines_names_the_item_it_removes_them_from() {
    let t = tempfile::tempdir().unwrap();
    let repo = t.path().join("repo");
    std::fs::create_dir_all(repo.join("src")).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("src/lib.rs"), GUARDED).unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "init"]);
    git(&repo, &["branch", "base"]);
    // The guard, the import and the whole of `removed_whole` go; nothing is added.
    let head =
        "\npub fn guarded_call(x: u8) -> u8 {\n    x\n}\n\npub fn last() -> u8 {\n    2\n}\n";
    std::fs::write(repo.join("src/lib.rs"), head).unwrap();
    git(&repo, &["commit", "-qam", "fix: drop the guard"]);
    let c = build(&repo, &diff_of(&repo), no_graph());
    let names: Vec<&str> = c.symbols.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, vec!["guarded_call"], "{c:?}");
    assert_eq!(c.unplaced, vec!["src/lib.rs:5 (lines removed after it)"]);
}

#[test]
fn a_removal_between_two_items_is_held_by_neither() {
    let text = "fn a() {\n    1\n}\nfn b() {\n    2\n}\n";
    let gone = crate::gate::lines::Removal {
        file: "a.rs".into(),
        after: 3,
        text: vec!["fn gone() {}".into()],
    };
    let (found, unplaced) = crate::consumers::removed::of_removals("a.rs", text, &[&gone]);
    assert!(found.is_empty(), "{found:?}");
    assert_eq!(unplaced, vec!["a.rs:3 (lines removed after it)"]);
}

#[test]
fn a_removal_inside_a_test_module_names_no_symbol() {
    let text = "#[cfg(test)]\nmod tests {\n    fn helper() {\n        1;\n        2;\n    }\n}\n";
    let gone = crate::gate::lines::Removal {
        file: "a.rs".into(),
        after: 4,
        text: vec!["        x();".into()],
    };
    let (found, unplaced) = crate::consumers::removed::of_removals("a.rs", text, &[&gone]);
    assert!(
        found.is_empty() && unplaced.is_empty(),
        "{found:?} {unplaced:?}"
    );
}
