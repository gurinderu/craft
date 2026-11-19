//! The name search: only Rust sources are searched, within a bound of lines and of time.

use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

use super::stream::{Ended, stream};
use super::{HITS_MAX, search};

fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap()
        .status
        .success();
    assert!(ok, "git {args:?}");
}

/// A repository whose tracked files name `wanted_name` on `md` lines of a Markdown file and on
/// one line each of `src/lib.rs` and the root `top.rs`.
fn repo(t: &Path, md: usize) -> std::path::PathBuf {
    let repo = t.join("repo");
    std::fs::create_dir_all(repo.join("src")).unwrap();
    git(&repo, &["init", "-q"]);
    std::fs::write(repo.join("README.md"), "wanted_name\n".repeat(md)).unwrap();
    std::fs::write(repo.join("src/lib.rs"), "pub fn wanted_name() {}\n").unwrap();
    std::fs::write(repo.join("top.rs"), "fn f() { wanted_name() }\n").unwrap();
    git(&repo, &["add", "."]);
    repo
}

fn far() -> Instant {
    Instant::now() + Duration::from_secs(60)
}

#[test]
fn a_name_common_outside_rust_sources_is_searched_in_them_and_listed() {
    let t = tempfile::tempdir().unwrap();
    let repo = repo(t.path(), HITS_MAX + 50);
    let mut found: Vec<(String, u32)> = search(&repo, "wanted_name", far())
        .unwrap()
        .into_iter()
        .map(|h| (h.file, h.line))
        .collect();
    found.sort();
    assert_eq!(found, [("src/lib.rs".into(), 1), ("top.rs".into(), 1)]);
}

#[test]
fn a_search_that_passes_the_line_cap_is_stopped_there() {
    // An endless stream of hits: read whole, it would never end; streamed, it stops past the cap.
    let mut cmd = Command::new("sh");
    cmd.args(["-c", "yes 'f.rs:1:x' | tr : '\\000'"]);
    let start = Instant::now();
    let ended = stream(cmd, start + Duration::from_secs(20)).unwrap();
    assert!(matches!(ended, Ended::Capped));
    assert!(start.elapsed() < Duration::from_secs(10));
}

#[test]
fn a_search_past_its_deadline_is_killed_and_says_so() {
    let mut cmd = Command::new("sh");
    cmd.args(["-c", "sleep 30"]);
    let start = Instant::now();
    let Err(why) = stream(cmd, start + Duration::from_millis(200)) else {
        panic!("a search past its deadline returned");
    };
    assert!(why.contains("no time left"), "{why}");
    assert!(start.elapsed() < Duration::from_secs(5));
}

#[test]
fn a_name_reached_after_the_deadline_is_not_searched() {
    let t = tempfile::tempdir().unwrap();
    let repo = repo(t.path(), 1);
    let Err(why) = search(&repo, "wanted_name", Instant::now()) else {
        panic!("a search after its deadline ran");
    };
    assert!(why.contains("no time left"), "{why}");
}

#[test]
fn git_s_failure_is_named() {
    let t = tempfile::tempdir().unwrap();
    let Err(why) = search(t.path(), "wanted_name", far()) else {
        panic!("a search outside a repository succeeded");
    };
    assert!(why.starts_with("git grep failed"), "{why}");
}

#[test]
fn a_crlf_line_s_text_ends_without_its_carriage_return() {
    let mut cmd = Command::new("printf");
    cmd.arg("f.rs\\0001\\000x()\\r\\n");
    let Ok(Ended::Exited(_, hits, _)) = stream(cmd, far()) else {
        panic!("printf did not exit");
    };
    assert_eq!(hits[0].text, "x()");
}
