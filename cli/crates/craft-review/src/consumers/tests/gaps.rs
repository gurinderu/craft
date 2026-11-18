//! What each audience is told of a list's gaps: the lenses what they can act on, the report all of
//! it, from one list of the gap fields.

use super::{diff_of, git};
use crate::consumers::{Consumers, build, gaps, lens_block, section};

#[test]
fn a_change_with_no_symbol_still_hands_the_lenses_its_unplaced_lines() {
    let c = Consumers {
        sources: vec!["name search".into()],
        unplaced: vec!["src/a.rs:3".into()],
        ..Consumers::default()
    };
    let block = lens_block(&c).unwrap();
    assert!(
        block.contains("Changed lines in no item this list could name (find what they change and its uses yourself): src/a.rs:3."),
        "{block:?}"
    );
}

#[test]
fn a_name_not_searched_is_not_said_to_have_no_consumer() {
    let t = tempfile::tempdir().unwrap();
    let repo = t.path().join("repo");
    std::fs::create_dir_all(repo.join("src")).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    let calls: String = (0..201).map(|i| format!("// busy_name {i}\n")).collect();
    std::fs::write(repo.join("src/calls.rs"), calls).unwrap();
    std::fs::write(repo.join("src/lib.rs"), "\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "init"]);
    git(&repo, &["branch", "base"]);
    let lib = "pub fn parse() -> u8 {\n    1\n}\n\npub fn busy_name() -> u8 {\n    2\n}\n";
    std::fs::write(repo.join("src/lib.rs"), lib).unwrap();
    git(&repo, &["commit", "-qam", "feat: change"]);
    let c = build(&repo, &diff_of(&repo), Err(String::new()));
    assert_eq!(c.unsearched.len(), 2, "{:?}", c.unsearched);
    assert_eq!(c.unsearched[0], "parse");
    assert!(
        c.unsearched[1].starts_with("busy_name ("),
        "{:?}",
        c.unsearched
    );
    let block = lens_block(&c).unwrap();
    assert!(block.contains("Not searched by name"), "{block}");
    assert!(
        !block.contains("No line outside the change names"),
        "{block}"
    );
}

/// A list with every gap field filled.
fn every_gap() -> Consumers {
    let one = |s: &str| vec![s.to_owned()];
    Consumers {
        sources: vec!["name search".into()],
        failed: "failed_x".into(),
        unsearched: one("unsearched_x"),
        unplaced: one("unplaced_x:1"),
        unlisted: one("unlisted_x (a.rs)"),
        unreadable: one("unreadable_x.rs (why)"),
        graph_skipped: "skipped_x".into(),
        graph_unlocated: 7,
        graph_unasked: one("unasked_x (why)"),
        graph_truncated: one("truncated_x"),
        ..Consumers::default()
    }
}

#[test]
fn every_gap_field_is_in_the_one_list() {
    let written = serde_json::to_value(every_gap()).unwrap();
    let mut fields: Vec<String> = written
        .as_object()
        .unwrap()
        .keys()
        .filter(|k| !["sources", "symbols", "cut", "capped", "file"].contains(&k.as_str()))
        .cloned()
        .collect();
    fields.sort();
    let mut listed: Vec<String> = gaps::all(&every_gap())
        .iter()
        .map(|g| g.field.to_owned())
        .collect();
    listed.sort();
    assert_eq!(fields, listed);
}

#[test]
fn each_gap_reaches_its_audiences_and_no_other() {
    let c = every_gap();
    let (report, block) = (section(&c), lens_block(&c).unwrap());
    let to_lens = [
        "unsearched_x",
        "unplaced_x:1",
        "unlisted_x",
        "unreadable_x.rs",
    ];
    let report_only = ["skipped_x", "7 codebase-memory", "unasked_x", "truncated_x"];
    for x in to_lens.iter().chain(&report_only) {
        assert!(report.contains(x), "report lacks {x}: {report}");
    }
    for x in to_lens {
        assert!(block.contains(x), "lens lacks {x}: {block}");
    }
    for x in report_only {
        assert!(!block.contains(x), "lens has {x}: {block}");
    }
    let told: Vec<&str> = gaps::all(&c)
        .iter()
        .filter(|g| g.to_lens)
        .map(|g| g.field)
        .collect();
    assert_eq!(
        told,
        ["failed", "unreadable", "unlisted", "unsearched", "unplaced"]
    );
    for g in gaps::all(&c) {
        assert!(g.said.is_some(), "{} said nothing", g.field);
    }
}
