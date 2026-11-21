//! The structural search over a repository: only the paths that reach the owner's item are
//! listed, within the name search's bounds of lines and of time, its files read as the list reads
//! them.

use std::path::Path;
use std::time::{Duration, Instant};

use super::super::HITS_MAX;
use super::super::crates::externals;
use super::super::paths::Externals;
use super::by_path;
use crate::cancel::Cancel;

fn git(dir: &Path, args: &[&str]) {
    let ok = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap()
        .status
        .success();
    assert!(ok, "git {args:?}");
}

const LIB: &str = "pub struct T;\nimpl T {\n    pub fn new() -> Self {\n        Self::new()\n    }\n}\npub fn run() {}\n";

/// A repository holding `T::new` in `src/lib.rs` and `uses` as `src/uses.rs`.
fn repo(t: &Path, uses: &str) -> std::path::PathBuf {
    let repo = t.join("repo");
    std::fs::create_dir_all(repo.join("src")).unwrap();
    git(&repo, &["init", "-q"]);
    std::fs::write(repo.join("src/lib.rs"), LIB).unwrap();
    std::fs::write(repo.join("src/uses.rs"), uses).unwrap();
    git(&repo, &["add", "."]);
    repo
}

fn far() -> Instant {
    Instant::now() + Duration::from_secs(60)
}

#[test]
fn only_the_paths_through_the_owner_are_listed() {
    let t = tempfile::tempdir().unwrap();
    let uses = "use crate::T;\nfn f() {\n    let a = T::new();\n    let m = HashMap::new();\n    // T::new()\n    let s = \"T::new()\";\n    a.new();\n}\n";
    let repo = repo(t.path(), uses);
    let found = by_path(
        &repo,
        ("src/lib.rs", 3),
        ("new", &Externals::default()),
        far(),
        &Cancel::default(),
    )
    .unwrap()
    .unwrap();
    let mut at: Vec<(String, u32, String)> = found
        .hits
        .into_iter()
        .map(|h| (h.file, h.line, h.text))
        .collect();
    at.sort();
    assert_eq!(
        at,
        [
            ("src/lib.rs".into(), 4, "        Self::new()".into()),
            ("src/uses.rs".into(), 3, "    let a = T::new();".into()),
        ]
    );
    assert!(found.unread.is_empty());
}

#[test]
fn a_free_item_is_not_searched_by_path() {
    let t = tempfile::tempdir().unwrap();
    let repo = repo(t.path(), "fn f() { crate::run() }\n");
    let found = by_path(
        &repo,
        ("src/lib.rs", 7),
        ("run", &Externals::default()),
        far(),
        &Cancel::default(),
    )
    .unwrap();
    assert!(found.is_none());
}

#[test]
fn a_search_past_the_line_cap_is_stopped_and_says_so() {
    let t = tempfile::tempdir().unwrap();
    let uses: String = (0..=HITS_MAX)
        .map(|i| format!("fn f{i}() {{ T::new(); }}\n"))
        .collect();
    let repo = repo(t.path(), &uses);
    let why = by_path(
        &repo,
        ("src/lib.rs", 3),
        ("new", &Externals::default()),
        far(),
        &Cancel::default(),
    )
    .unwrap_err();
    assert_eq!(why, format!("over {HITS_MAX} lines"));
}

#[test]
fn a_search_reached_after_the_deadline_does_not_run() {
    let t = tempfile::tempdir().unwrap();
    let repo = repo(t.path(), "fn f() { T::new(); }\n");
    let why = by_path(
        &repo,
        ("src/lib.rs", 3),
        ("new", &Externals::default()),
        Instant::now(),
        &Cancel::default(),
    )
    .unwrap_err();
    assert!(why.contains("no time left"), "{why}");
}

#[test]
fn a_file_the_list_cannot_read_is_not_parsed_and_is_named() {
    let t = tempfile::tempdir().unwrap();
    let repo = repo(t.path(), "fn f() { T::new(); }\n");
    std::fs::write(repo.join("src/bad.rs"), b"fn g() { T::new(); } // \xff\n").unwrap();
    git(&repo, &["add", "."]);
    let found = by_path(
        &repo,
        ("src/lib.rs", 3),
        ("new", &Externals::default()),
        far(),
        &Cancel::default(),
    )
    .unwrap()
    .unwrap();
    assert!(found.hits.iter().all(|h| h.file != "src/bad.rs"));
    assert_eq!(found.unread.len(), 1, "{:?}", found.unread);
    assert!(
        found.unread[0].starts_with("src/bad.rs (not UTF-8"),
        "{:?}",
        found.unread
    );
}

#[test]
fn a_path_through_a_workspace_dependency_is_not_listed() {
    let t = tempfile::tempdir().unwrap();
    let uses = "fn f() {\n    tokio::sync::T::new();\n    crate::T::new();\n}\n";
    let repo = repo(t.path(), uses);
    std::fs::write(
        repo.join("Cargo.toml"),
        "[package]\nname = \"app\"\n[dependencies]\ntokio = \"1\"\n",
    )
    .unwrap();
    git(&repo, &["add", "."]);
    let found = by_path(
        &repo,
        ("src/lib.rs", 3),
        ("new", &externals(&repo, (far(), &Cancel::default()))),
        far(),
        &Cancel::default(),
    )
    .unwrap()
    .unwrap();
    let at: Vec<(&str, u32)> = found
        .hits
        .iter()
        .map(|h| (h.file.as_str(), h.line))
        .collect();
    assert!(at.contains(&("src/uses.rs", 3)), "{at:?}");
    assert!(!at.contains(&("src/uses.rs", 2)), "{at:?}");
}
