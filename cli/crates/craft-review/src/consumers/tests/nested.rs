//! A graph caller in another checkout inside this one — a linked worktree under the main
//! checkout, which the graph indexes and the name search leaves out — is not listed, and the
//! checkout is named once among the files not read.

use super::reindex::{INDEXED, graph};
use super::{diff_of, fixture, repo_root, sites};
use crate::consumers::{GRAPH, build};

#[test]
fn a_caller_in_a_checkout_nested_in_this_one_is_named_not_listed() {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "");
    let nested = repo.join(".worktrees/other/src");
    std::fs::create_dir_all(&nested).unwrap();
    std::fs::write(repo.join(".worktrees/other/.git"), "gitdir: elsewhere\n").unwrap();
    std::fs::write(
        nested.join("uses.rs"),
        "fn f() {\n    k8s_rule_to_api(1);\n}\n",
    )
    .unwrap();
    let rows = r#"["k8s_rule_to_api","src/lib.rs",".worktrees/other/src/uses.rs","1","3","2"],["k8s_rule_to_api","src/lib.rs",".worktrees/other/src/uses.rs","1","3","2"]"#;
    let g = graph(t.path(), &repo_root(t.path()), INDEXED, rows, false);
    let c = build(&repo, &diff_of(&repo), Ok(g));
    let listed = sites(&c, "k8s_rule_to_api");
    assert!(
        listed
            .iter()
            .all(|(f, _, from)| !f.starts_with(".worktrees/") || !from.iter().any(|s| s == GRAPH)),
        "{listed:?}"
    );
    assert_eq!(
        c.graph_unreadable,
        vec![".worktrees/other/ (another checkout inside this one)"],
        "{c:?}"
    );
}
