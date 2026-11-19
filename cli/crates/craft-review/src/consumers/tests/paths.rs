//! A changed Rust file is read whatever characters its path holds: git quotes a non-ASCII byte
//! in a listing, ends a header's path holding a space with a tab, and quotes one holding a quote.

use super::{diff_of, git};
use crate::consumers::build;

#[test]
fn a_changed_file_under_any_path_has_its_symbols_listed() {
    let t = tempfile::tempdir().unwrap();
    let repo = t.path().join("repo");
    std::fs::create_dir_all(repo.join("my dir")).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("README"), "r\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "init"]);
    git(&repo, &["branch", "base"]);
    let files = [
        ("café.rs", "accented_fn"),
        ("my dir/x.rs", "spaced_fn"),
        ("q\"t.rs", "quoted_fn"),
    ];
    for (path, name) in files {
        std::fs::write(
            repo.join(path),
            format!("pub fn {name}() -> u8 {{\n    1\n}}\n"),
        )
        .unwrap();
    }
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "feat: change"]);
    let c = build(&repo, &diff_of(&repo));
    let mut listed: Vec<(String, String)> = c
        .symbols
        .iter()
        .map(|s| (s.file.clone(), s.name.clone()))
        .collect();
    listed.sort();
    let mut want: Vec<(String, String)> = files
        .iter()
        .map(|(p, n)| ((*p).to_owned(), (*n).to_owned()))
        .collect();
    want.sort();
    assert_eq!(listed, want, "{c:?}");
    assert!(c.unreadable.is_empty() && c.unplaced.is_empty(), "{c:?}");
}
