//! Each task's part of the list: its scope's symbols, lines and gaps, cut to its budget.

use crate::consumers::order::{LENS_MAX, SEAM_MAX};
use crate::consumers::{
    Consumers, Listed, Site, confined_block, lens_block, seam_block, seam_sites, slice_block,
};

fn site(file: &str, line: u32) -> Site {
    Site {
        file: file.into(),
        line,
        text: "use_it()".into(),
        from: vec!["name search".into()],
        kind: String::new(),
    }
}

fn symbol(name: &str, file: &str, sites: Vec<Site>) -> Listed {
    Listed {
        name: name.into(),
        file: file.into(),
        line: 1,
        sites,
    }
}

/// `a` declared in `a/lib.rs`, used once in `x/use.rs`; `b` in `b/lib.rs`, used once in `y/use.rs`;
/// one gap of each kind in each of the two files.
fn two() -> Consumers {
    Consumers {
        sources: vec!["name search".into()],
        symbols: vec![
            symbol("a", "a/lib.rs", vec![site("x/use.rs", 3)]),
            symbol("b", "b/lib.rs", vec![site("y/use.rs", 4)]),
        ],
        unlisted: vec!["la (a/lib.rs)".into(), "lb (b/lib.rs)".into()],
        unplaced: vec!["a/lib.rs:9".into(), "b/lib.rs:9".into()],
        unreadable: vec!["a/bad.rs (gone)".into(), "b/bad.rs (gone)".into()],
        file: "/run/consumers.json".into(),
        ..Consumers::default()
    }
}

#[test]
fn a_slice_carries_only_the_symbols_declared_in_its_files_and_their_gaps() {
    let block = slice_block(&two(), &["a/lib.rs".into(), "a/bad.rs".into()]).unwrap();
    for kept in [
        "x/use.rs:3",
        "la (a/lib.rs)",
        "a/lib.rs:9",
        "a/bad.rs (gone)",
    ] {
        assert!(block.contains(kept), "{kept} missing: {block}");
    }
    for gone in ["y/use.rs:4", "lb (b/lib.rs)", "b/lib.rs:9", "b/bad.rs"] {
        assert!(!block.contains(gone), "{gone} kept: {block}");
    }
}

#[test]
fn a_slice_with_no_symbol_or_gap_of_its_own_carries_no_block() {
    assert_eq!(slice_block(&two(), &["c/lib.rs".into()]).unwrap(), "");
}

#[test]
fn an_unsearched_name_goes_where_its_symbol_is_declared_or_everywhere_when_unknown() {
    let c = Consumers {
        symbols: vec![
            symbol("a", "a/lib.rs", vec![]),
            symbol("b", "b/lib.rs", vec![]),
        ],
        unsearched: vec!["a (over 200 lines)".into(), "b".into(), "ghost".into()],
        ..two()
    };
    let block = slice_block(&c, &["a/lib.rs".into()]).unwrap();
    assert!(block.contains("a (over 200 lines)"), "{block}");
    assert!(block.contains("ghost"), "{block}");
    assert!(!block.contains(", b"), "{block}");
}

#[test]
fn a_part_past_its_budget_says_how_many_lines_it_cut_and_where_they_are() {
    let many = (0..40).map(|n| symbol(&format!("s{n}"), "a/lib.rs", vec![site("x/u.rs", n)]));
    let c = Consumers {
        symbols: many.collect(),
        ..two()
    };
    let block = lens_block(&c).unwrap();
    let shown = block.lines().filter(|l| l.starts_with("- ")).count();
    assert_eq!(shown, LENS_MAX, "{block}");
    assert!(
        block.contains(&format!(
            "{} more cut by the budget to keep this prompt small, not yours to mark: the whole list is `/run/consumers.json`",
            40 - LENS_MAX
        )),
        "{block}"
    );
    assert!(
        block.contains(&format!("the {LENS_MAX} line(s) below")),
        "{block}"
    );
}

#[test]
fn a_confined_part_does_not_call_a_symbol_used_only_elsewhere_unused() {
    let block = confined_block(&two(), &["x".into()], "crate").unwrap();
    assert!(block.contains("x/use.rs:3"), "{block}");
    assert!(
        !block.contains("No line outside the change names"),
        "{block}"
    );
    assert!(
        block.contains("1 more line(s) name these symbols in other crates"),
        "{block}"
    );
}

#[test]
fn the_seam_part_is_held_to_its_own_budget_and_names_what_it_shows() {
    let many = (0..100).map(|n| symbol(&format!("s{n}"), "a/lib.rs", vec![site("x/u.rs", n)]));
    let c = Consumers {
        symbols: many.collect(),
        ..two()
    };
    let shown = seam_sites(&c);
    assert_eq!(shown.len(), SEAM_MAX);
    let block = seam_block(&c);
    assert!(block.contains("x/u.rs:79: "), "{block}");
    assert!(!block.contains("x/u.rs:80: "), "{block}");
    assert!(block.contains("20 more cut by the budget"), "{block}");
}
