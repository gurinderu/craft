//! The structural search in the list: a changed item of an `impl` whose name is too common to
//! search by text is listed where a path reaches it, under its own source, within the list's
//! budgets, a free function by its module.

use std::path::Path;

use super::{diff_of, git, no_graph, sites};
use crate::consumers::{NAME_SEARCH, STRUCTURAL, build, keep, order, section};

const LIB: &str =
    "pub struct T;\nimpl T {\n    pub fn new() -> u8 {\n        1\n    }\n}\npub fn run() {}\n";
const CHANGED: &str =
    "pub struct T;\nimpl T {\n    pub fn new() -> u8 {\n        2\n    }\n}\npub fn run() { () }\n";

/// A repository whose change rewrites `T::new`'s body and the free `run`; `src/uses.rs` is `uses`.
fn fixture(t: &Path, uses: &str) -> std::path::PathBuf {
    let repo = t.join("repo");
    std::fs::create_dir_all(repo.join("src")).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("src/lib.rs"), LIB).unwrap();
    std::fs::write(repo.join("src/uses.rs"), uses).unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "init"]);
    git(&repo, &["branch", "base"]);
    std::fs::write(repo.join("src/lib.rs"), CHANGED).unwrap();
    git(&repo, &["commit", "-qam", "feat: change"]);
    repo
}

#[test]
fn a_common_name_of_an_impl_is_listed_where_a_path_reaches_it() {
    let t = tempfile::tempdir().unwrap();
    let uses = "fn f() { let _ = crate::T::new(); let _ = HashMap::new(); }\n// T::new()\nfn g() { crate::run(); }\nfn h() { other::run(); }\n";
    let repo = fixture(t.path(), uses);
    let c = build(&repo, &diff_of(&repo), no_graph());
    assert_eq!(c.sources, vec![NAME_SEARCH, STRUCTURAL]);
    assert_eq!(
        sites(&c, "new"),
        vec![("src/uses.rs".to_owned(), 1, vec![STRUCTURAL.to_owned()])]
    );
    assert_eq!(
        sites(&c, "run"),
        vec![("src/uses.rs".to_owned(), 3, vec![STRUCTURAL.to_owned()])]
    );
    assert_eq!(c.unsearched.len(), 2, "{:?}", c.unsearched);
    for (u, name) in c.unsearched.iter().zip(["new", "run"]) {
        assert!(
            u.starts_with(&format!("{name} (searched by path only"))
                && u.contains("through a value"),
            "{:?}",
            c.unsearched
        );
    }
    assert!(section(&c).contains("Built from: name search, structural search."));
}

#[test]
fn the_structural_lines_are_held_to_the_list_s_budget() {
    let t = tempfile::tempdir().unwrap();
    let uses: String = (0..15)
        .map(|i| format!("fn c{i}() {{ crate::T::new(); }}\n"))
        .collect();
    let repo = fixture(t.path(), &uses);
    let full = build(&repo, &diff_of(&repo), no_graph());
    assert_eq!(sites(&full, "new").len(), 15);
    let (c, _) = keep(&t.path().join("none"), full);
    assert_eq!(sites(&c, "new").len(), 15);
    let block = crate::consumers::lens_block(&c).unwrap();
    let shown = block.lines().filter(|l| l.starts_with("- ")).count();
    assert_eq!(shown, order::PER_SYMBOL, "{block}");
    assert!(block.contains("5 more cut by the budget"), "{block}");
}

#[test]
fn a_change_with_no_common_name_of_an_owner_has_no_structural_source() {
    let t = tempfile::tempdir().unwrap();
    let repo = super::fixture(t.path(), "");
    let c = build(&repo, &diff_of(&repo), no_graph());
    assert_eq!(c.sources, vec![NAME_SEARCH]);
}

#[test]
fn a_name_past_the_name_search_s_cap_is_searched_by_path() {
    let t = tempfile::tempdir().unwrap();
    let lib = LIB.replace("fn new", "fn create");
    let changed = CHANGED.replace("fn new", "fn create");
    let repo = t.path().join("repo");
    std::fs::create_dir_all(repo.join("src")).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("src/lib.rs"), lib).unwrap();
    let mut uses: String = (0..=crate::consumers::names::HITS_MAX)
        .map(|i| format!("fn c{i}(o: O) {{ o.create(); }}\n"))
        .collect();
    uses.push_str("fn made() { crate::T::create(); }\n");
    std::fs::write(repo.join("src/uses.rs"), &uses).unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "init"]);
    git(&repo, &["branch", "base"]);
    std::fs::write(repo.join("src/lib.rs"), changed).unwrap();
    git(&repo, &["commit", "-qam", "feat: change"]);
    let c = build(&repo, &diff_of(&repo), no_graph());
    let last = u32::try_from(crate::consumers::names::HITS_MAX).unwrap() + 2;
    assert_eq!(
        sites(&c, "create"),
        vec![("src/uses.rs".to_owned(), last, vec![STRUCTURAL.to_owned()])]
    );
    let note = c
        .unsearched
        .iter()
        .find(|u| u.starts_with("create"))
        .unwrap();
    assert!(
        note.starts_with("create (over 200 lines; searched by path only"),
        "{note}"
    );
}
