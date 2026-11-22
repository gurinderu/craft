use std::path::Path;
use std::process::Command;

use super::{Consumers, GRAPH, NAME_SEARCH, build, graph_of, lens_block, section};
use crate::project::CodeGraph;

/// No graph to ask: the list is the name search alone.
pub(super) fn no_graph() -> Result<CodeGraph, super::GraphError> {
    Err(super::GraphError::NoProfiles)
}

use crate::gate::tests::exe;

mod asks;
mod built;
mod changed;
mod checkout;
mod gaps;
mod graphs;
mod half_asked;
mod heads;
mod heartbeat;
mod index;
mod lists;
mod lock;
mod metrics;
mod metrics_unread;
mod nested;
mod paths;
mod reindex;
mod stale;
mod structural;
mod structural_bounds;
mod structural_gaps;
mod structural_imports;
mod walk;

pub(super) fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}");
    String::from_utf8(out.stdout).unwrap()
}

const LIB: &str = "pub fn k8s_rule_to_api(x: u8) -> u8 {\n    x\n}\n";
const USES: &str = "use crate::k8s_rule_to_api;\n\npub fn all(v: Vec<u8>) -> Vec<u8> {\n    v.into_iter().map(k8s_rule_to_api).collect()\n}\n// k8s_rule_to_api in a comment\n";

/// A repository on `main` whose change rewrites `k8s_rule_to_api`'s body and adds a call on a
/// changed line; `src/uses.rs` passes it as a value, unchanged.
pub(super) fn fixture(t: &Path, extra: &str) -> std::path::PathBuf {
    let repo = t.join("repo");
    std::fs::create_dir_all(repo.join("src")).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("src/lib.rs"), LIB).unwrap();
    std::fs::write(repo.join("src/uses.rs"), format!("{USES}{extra}")).unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "init"]);
    git(&repo, &["branch", "base"]);
    let changed = "pub fn k8s_rule_to_api(x: u8) -> u8 {\n    x + 1\n}\n\npub fn twice(x: u8) -> u8 {\n    k8s_rule_to_api(k8s_rule_to_api(x))\n}\n";
    std::fs::write(repo.join("src/lib.rs"), changed).unwrap();
    git(&repo, &["commit", "-qam", "feat: change"]);
    repo
}

/// The root the stand-in graphs index: the fixture's repository, as git names its top level.
pub(super) fn repo_root(t: &Path) -> String {
    let repo = t.join("repo");
    repo.canonicalize().unwrap_or(repo).display().to_string()
}

pub(super) fn diff_of(repo: &Path) -> crate::git::Diff {
    crate::git::read_diff(repo, Some("base"), None).unwrap()
}

pub(super) fn sites(c: &Consumers, name: &str) -> Vec<(String, u32, Vec<String>)> {
    c.symbols
        .iter()
        .find(|s| s.name == name)
        .map(|s| {
            s.sites
                .iter()
                .map(|x| (x.file.clone(), x.line, x.from.clone()))
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn the_name_search_finds_a_function_passed_as_a_value_and_skips_changed_lines() {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "");
    let c = build(&repo, &diff_of(&repo), no_graph());
    let names = vec![NAME_SEARCH.to_owned()];
    assert_eq!(c.sources, names);
    // The `use` line and the `.map(k8s_rule_to_api)` line; not the comment, not the declaration,
    // not the call on the changed line 6 of src/lib.rs.
    assert_eq!(
        sites(&c, "k8s_rule_to_api"),
        vec![
            ("src/uses.rs".to_owned(), 1, names.clone()),
            ("src/uses.rs".to_owned(), 4, names),
        ]
    );
    // `twice`, added, has no consumer.
    assert_eq!(sites(&c, "twice"), vec![]);
    assert_eq!(c.graph_skipped, "no review profile directory");
}

#[test]
fn the_budget_keeps_ten_lines_a_symbol_and_counts_the_rest() {
    let t = tempfile::tempdir().unwrap();
    let calls: String = (0..15)
        .map(|i| format!("fn c{i}() {{ k8s_rule_to_api(1); }}\n"))
        .collect();
    let repo = fixture(t.path(), &calls);
    let full = build(&repo, &diff_of(&repo), no_graph());
    assert_eq!(sites(&full, "k8s_rule_to_api").len(), 17);
    let (c, _) = super::keep(&t.path().join("none"), full);
    assert_eq!(sites(&c, "k8s_rule_to_api").len(), super::order::PER_SYMBOL);
    assert_eq!(c.cut, 17 - super::order::PER_SYMBOL);
    assert!(lens_block(&c).unwrap().contains("7 more cut by the budget"));
}

#[test]
fn the_run_budget_takes_each_symbol_in_turn() {
    let listed = |n: usize| super::Listed {
        name: format!("s{n}"),
        file: String::new(),
        line: 1,
        sites: (0..10)
            .map(|i| super::Site {
                file: "f.rs".into(),
                line: i,
                text: String::new(),
                from: vec![],
                kind: String::new(),
            })
            .collect(),
    };
    let mut all: Vec<_> = (0..9).map(listed).collect();
    let cut = super::order::budget(&mut all, super::order::PER_SYMBOL, super::order::RUN_MAX);
    assert_eq!(cut, 90 - super::order::RUN_MAX);
    let kept: Vec<usize> = all.iter().map(|s| s.sites.len()).collect();
    assert_eq!(kept, vec![9, 9, 9, 9, 9, 9, 9, 9, 8]);
}

/// A stand-in code graph: `index_status` answers `indexed_at`, `query_graph` one caller of
/// `k8s_rule_to_api` in `src/uses.rs` lines 3–5, one in lines 7–8 that names it nowhere, and one
/// of another item of that name.
pub(super) fn graph(t: &Path, indexed_at: &str) -> CodeGraph {
    let tool = t.join("cbm");
    let script = format!(
        "#!/bin/sh\ncase \"$3\" in\n index_repository) echo '{{\"status\":\"indexed\"}}';;\n index_status) echo '{{\"status\":\"ready\",\"indexed_at\":\"{indexed_at}\",\"root_path\":\"{root}\"}}';;\n query_graph) echo \"$4\" >> {log}; case \"$4\" in *k8s_rule_to_api*) echo '{{\"has_more\":true,\"rows\":[[\"k8s_rule_to_api\",\"src/lib.rs\",\"src/uses.rs\",\"3\",\"5\"],[\"k8s_rule_to_api\",\"src/lib.rs\",\"src/uses.rs\",\"7\",\"8\"],[\"k8s_rule_to_api\",\"src/elsewhere.rs\",\"src/uses.rs\",\"1\",\"1\"]]}}';; *) echo '{{\"rows\":[]}}';; esac;;\n list_projects) echo '{{\"projects\":[{{\"name\":\"p\",\"root_path\":\"/r\"}}]}}';;\n *) echo '{{\"error\":\"unknown\"}}'; exit 1;;\nesac\n",
        log = t.join("queries").display(),
        root = repo_root(t)
    );
    exe::write_executable(&tool, &script).unwrap();
    CodeGraph::indexed(&tool.display().to_string(), "p")
}

#[test]
fn a_fresh_graph_is_merged_with_the_name_search_each_line_once() {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "fn m() {\n    call!(x);\n}\n");
    let c = build(
        &repo,
        &diff_of(&repo),
        Ok(graph(t.path(), "2099-01-01T00:00:00Z")),
    );
    assert_eq!(c.sources, vec![NAME_SEARCH, GRAPH]);
    let both = vec![NAME_SEARCH.to_owned(), GRAPH.to_owned()];
    assert_eq!(
        sites(&c, "k8s_rule_to_api"),
        vec![
            ("src/uses.rs".to_owned(), 1, vec![NAME_SEARCH.to_owned()]),
            ("src/uses.rs".to_owned(), 4, both),
        ]
    );
    assert!(c.graph_skipped.is_empty());
    assert!(section(&c).contains("Built from: name search, codebase-memory."));
}

#[test]
fn a_stale_or_absent_graph_leaves_the_name_search_alone_and_says_why() {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "");
    let c = build(
        &repo,
        &diff_of(&repo),
        Ok(graph(t.path(), "2000-01-01T00:00:00Z")),
    );
    assert_eq!(c.sources, vec![NAME_SEARCH]);
    assert!(
        c.graph_skipped
            .contains("so which commit it was made of is unknown")
            && !c.graph_skipped.contains("warmup"),
        "{}",
        c.graph_skipped
    );
    let s = section(&c);
    assert!(s.contains("Built from: name search."), "{s}");
    assert!(
        s.contains("codebase-memory not used: the index of craft-review-")
            && s.contains("names no commit"),
        "{s}"
    );

    let projects = t.path().join("projects");
    let why = graph_of(Some(&projects), &repo).unwrap_err().to_string();
    assert!(why.contains("names no code graph"), "{why}");
}

#[test]
fn the_lens_block_lists_every_line_by_symbol() {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "");
    let c = build(&repo, &diff_of(&repo), no_graph());
    let block = lens_block(&c).unwrap();
    assert!(block.contains("CONSUMERS: the 2 line(s)"), "{block}");
    assert!(block.contains("`k8s_rule_to_api` (src/lib.rs:1):\n- src/uses.rs:1: use crate::k8s_rule_to_api;\n- src/uses.rs:4: v.into_iter().map(k8s_rule_to_api).collect()"), "{block}");
    assert!(
        block.contains("No line outside the change names: `twice`."),
        "{block}"
    );
    assert_eq!(lens_block(&Consumers::default()).unwrap(), "");
}

#[test]
fn a_changed_line_names_the_item_around_it_and_a_test_fn_is_left_out() {
    let text = "impl A {\n    pub(crate) fn outer(\n        a: u8,\n    ) -> u8 {\n        a\n    }\n}\n\n#[test]\nfn checks() {\n    x();\n}\nconst LIMIT: u8 = 3;\n";
    let names = |ranges: &[(u32, u32)]| -> Vec<String> {
        super::symbols::of_file("a.rs", text, ranges)
            .0
            .into_iter()
            .map(|s| format!("{}:{}", s.name, s.line))
            .collect()
    };
    assert_eq!(names(&[(5, 5)]), vec!["outer:2"]);
    assert_eq!(names(&[(11, 11)]), Vec::<String>::new());
    assert_eq!(names(&[(13, 13), (3, 3)]), vec!["LIMIT:13", "outer:2"]);
    assert_eq!(names(&[(7, 8)]), Vec::<String>::new());
}
