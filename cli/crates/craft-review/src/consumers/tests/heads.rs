//! What the graph's answer is checked against in head: the root its index is of, and each
//! caller's file and span read only inside the repository.

use std::path::Path;
use std::time::{Duration, Instant};

use super::{diff_of, fixture, repo_root, sites};
use crate::consumers::{GRAPH, build, lens_block, names, section};
use crate::gate::tests::exe;
use crate::project::CodeGraph;

/// A stand-in graph whose index is of `root`, made in 2099, and whose callers of
/// `k8s_rule_to_api` are `rows` (JSON rows, `'` free).
fn index_of(t: &Path, root: &str, rows: &str) -> CodeGraph {
    let tool = t.join("cbm");
    let script = format!(
        "#!/bin/sh\ncase \"$3\" in\n index_repository) echo '{{\"status\":\"indexed\"}}';;\n index_status) echo '{{\"status\":\"ready\",\"indexed_at\":\"2099-01-01T00:00:00Z\",\"root_path\":\"{root}\"}}';;\n query_graph) case \"$4\" in *\"AND NOT (\"*k8s_rule_to_api*|*k8s_rule_to_api*\"AND NOT (\"*) echo '{{\"rows\":[{rows}]}}';; *) echo '{{\"rows\":[]}}';; esac;;\nesac\n"
    );
    exe::write_executable(&tool, &script).unwrap();
    CodeGraph::indexed(&tool.display().to_string(), "p")
}

fn row(file: &str, start: u64, end: u64) -> String {
    format!(r#"["k8s_rule_to_api","src/lib.rs","{file}","{start}","{end}"]"#)
}

#[test]
fn an_index_of_another_repository_is_not_asked() {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "");
    let g = index_of(t.path(), "/elsewhere", &row("src/uses.rs", 3, 5));
    let c = build(&repo, &diff_of(&repo), Ok(g));
    assert!(
        c.graph_skipped
            .contains("is of /elsewhere, not of this checkout"),
        "{}",
        c.graph_skipped
    );
    assert!(!c.sources.contains(&GRAPH.to_owned()), "{:?}", c.sources);
}

#[test]
fn an_index_naming_no_root_is_not_asked() {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "");
    let g = index_of(t.path(), "", &row("src/uses.rs", 3, 5));
    let ready = crate::consumers::graph::ready(
        &repo,
        &diff_of(&repo).merge_base,
        (&g, &crate::consumers::cbm::scratch_locks()),
        &crate::cancel::Cancel::default(),
    );
    let Err(why) = ready else {
        panic!("an index naming no root was taken as ready");
    };
    assert!(
        matches!(why, crate::consumers::GraphError::NoRoot { .. }),
        "{why}"
    );
    let c = build(&repo, &diff_of(&repo), Ok(g));
    assert!(
        c.graph_skipped.contains("names no root it indexes"),
        "{}",
        c.graph_skipped
    );
    assert!(!c.sources.contains(&GRAPH.to_owned()), "{:?}", c.sources);
}

#[test]
fn a_caller_outside_the_repository_or_in_a_file_that_cannot_be_read_is_named_not_listed() {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "");
    std::fs::create_dir_all(repo.join("src/dir.rs")).unwrap();
    std::fs::write(t.path().join("outside.rs"), "k8s_rule_to_api\n").unwrap();
    let outside = t.path().join("outside.rs").display().to_string();
    let rows = [
        row("../outside.rs", 1, 1),
        row(&outside, 1, 1),
        row("src/dir.rs", 1, 1),
        row("src/dir.rs", 2, 2),
    ]
    .join(",");
    let g = index_of(t.path(), &repo_root(t.path()), &rows);
    let c = build(&repo, &diff_of(&repo), Ok(g));
    assert_eq!(c.graph_unreadable.len(), 3, "{:?}", c.graph_unreadable);
    assert_eq!(
        c.graph_unreadable[0],
        "../outside.rs (outside the repository)"
    );
    assert_eq!(
        c.graph_unreadable[1],
        format!("{outside} (outside the repository)")
    );
    assert!(
        c.graph_unreadable[2] == "src/dir.rs (not a regular file)",
        "{:?}",
        c.graph_unreadable
    );
    assert_eq!(c.graph_unlocated, 0);
    let listed = sites(&c, "k8s_rule_to_api");
    assert!(
        listed.iter().all(|(f, ..)| f == "src/uses.rs"),
        "{listed:?}"
    );
    assert!(
        section(&c).contains("- codebase-memory callers in files not read: ../outside.rs"),
        "{}",
        section(&c)
    );
    // Report-only: the name search ran for these symbols anyway (consumers/gaps.rs).
    assert!(
        !lens_block(&c).unwrap().contains("../outside.rs"),
        "{}",
        lens_block(&c).unwrap()
    );
}

#[cfg(unix)]
#[test]
fn a_caller_file_reached_through_a_link_is_named_not_read() {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "");
    let secret = t.path().join("secret");
    std::fs::create_dir_all(&secret).unwrap();
    std::fs::write(secret.join("creds.rs"), "k8s_rule_to_api = hunter2\n").unwrap();
    std::os::unix::fs::symlink(secret.join("creds.rs"), repo.join("src/creds.rs")).unwrap();
    std::os::unix::fs::symlink(&secret, repo.join("linked")).unwrap();
    std::os::unix::fs::symlink("/dev/zero", repo.join("src/zero.rs")).unwrap();
    let rows = [
        row("src/creds.rs", 1, 1),
        row("linked/creds.rs", 1, 1),
        row("src/zero.rs", 1, 1),
    ]
    .join(",");
    let g = index_of(t.path(), &repo_root(t.path()), &rows);
    let c = build(&repo, &diff_of(&repo), Ok(g));
    assert_eq!(
        c.graph_unreadable,
        vec![
            "src/creds.rs (reached through a link)",
            "linked/creds.rs (reached through a link)",
            "src/zero.rs (reached through a link)",
        ],
    );
    let listed = sites(&c, "k8s_rule_to_api");
    assert!(
        listed.iter().all(|(f, ..)| f == "src/uses.rs"),
        "{listed:?}"
    );
}

#[test]
fn a_span_past_the_file_s_end_is_read_to_its_end_only() {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "");
    let g = index_of(
        t.path(),
        &repo_root(t.path()),
        &row("src/uses.rs", 3, 4_000_000_000),
    );
    let start = Instant::now();
    let c = build(&repo, &diff_of(&repo), Ok(g));
    assert!(
        start.elapsed() < Duration::from_secs(5),
        "{:?}",
        start.elapsed()
    );
    let line4 = sites(&c, "k8s_rule_to_api");
    assert!(
        line4
            .iter()
            .any(|(f, n, from)| f == "src/uses.rs" && *n == 4 && from.contains(&GRAPH.to_owned())),
        "{line4:?}"
    );
}

#[test]
fn a_span_over_a_comment_or_a_changed_line_lists_neither() {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "");
    let rows = [row("src/uses.rs", 1, 6), row("src/lib.rs", 5, 7)].join(",");
    let g = index_of(t.path(), &repo_root(t.path()), &rows);
    let c = build(&repo, &diff_of(&repo), Ok(g));
    let listed = sites(&c, "k8s_rule_to_api");
    let lines: Vec<(String, u32)> = listed.iter().map(|(f, n, _)| (f.clone(), *n)).collect();
    assert_eq!(
        lines,
        vec![("src/uses.rs".to_owned(), 1), ("src/uses.rs".to_owned(), 4)]
    );
}

#[test]
fn a_name_is_found_only_as_a_whole_word() {
    assert!(names::names("k(x)", "k"));
    assert!(names::names("a.k8s_rule_to_api()", "k8s_rule_to_api"));
    assert!(!names::names("k8s_rule_to_api_v2(x)", "k8s_rule_to_api"));
    assert!(!names::names("my_k8s_rule_to_api(x)", "k8s_rule_to_api"));
    assert!(!names::names("rk8s_rule_to_api", "k8s_rule_to_api"));
    assert!(names::names("k8s_rule_to_api", "k8s_rule_to_api"));
}
