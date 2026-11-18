//! What the list holds: other declarations of the name, the whole list saved apart from the
//! lenses' budgeted part, graph callers only where head names the symbol, the graph asked per
//! symbol.

use std::path::Path;

use super::{diff_of, fixture, graph};
use crate::consumers::{
    Consumers, FILE, GRAPH, Listed, SAME_NAME, Site, build, keep, lens_block, order, section,
};

#[test]
fn another_declaration_of_the_name_is_listed_as_an_implementor_or_sibling() {
    let t = tempfile::tempdir().unwrap();
    let extra = "pub struct A;\nimpl Rule for A {\n    fn k8s_rule_to_api(&self) -> u8 {\n        0\n    }\n}\n";
    let repo = fixture(t.path(), extra);
    let c = build(&repo, &diff_of(&repo), Err(String::new()));
    let s = &c.symbols[0];
    let listed: Vec<(&str, u32, &str)> = s
        .sites
        .iter()
        .map(|x| (x.file.as_str(), x.line, x.kind.as_str()))
        .collect();
    assert!(
        listed.contains(&("src/uses.rs", 9, SAME_NAME)),
        "{listed:?}"
    );
    // Its own declaration is not.
    assert!(!listed.iter().any(|x| x.0 == "src/lib.rs" && x.1 == 1));
    assert!(lens_block(&c).unwrap().contains(SAME_NAME));
}

#[test]
fn the_whole_list_is_saved_and_the_lenses_get_the_budgeted_part() {
    let t = tempfile::tempdir().unwrap();
    let calls: String = (0..15)
        .map(|i| format!("fn c{i}() {{ k8s_rule_to_api(1); }}\n"))
        .collect();
    let repo = fixture(t.path(), &calls);
    let full = build(&repo, &diff_of(&repo), Err(String::new()));
    let dir = t.path().join("run");
    std::fs::create_dir_all(&dir).unwrap();
    let (lens, note) = keep(&dir, full);
    assert_eq!(note, None);
    let saved: Consumers =
        serde_json::from_str(&std::fs::read_to_string(dir.join(FILE)).unwrap()).unwrap();
    assert_eq!(saved.lines(), 17);
    assert_eq!(lens.lines(), order::PER_SYMBOL);
    assert_eq!(lens.cut, 7);
    let path = dir.join(FILE).display().to_string();
    assert_eq!(lens.file, path);
    assert!(
        lens_block(&lens)
            .unwrap()
            .contains(&format!("7 more cut by the budget, all in `{path}`"))
    );
}

#[test]
fn the_hard_cap_counts_what_no_file_holds() {
    let listed = |n: usize| Listed {
        name: format!("s{n}"),
        file: String::new(),
        line: 1,
        sites: (0..600)
            .map(|i| Site {
                file: "f.rs".into(),
                line: i,
                text: String::new(),
                from: vec![],
                kind: String::new(),
            })
            .collect(),
    };
    let mut all = vec![listed(0), listed(1)];
    assert_eq!(order::budget(&mut all, usize::MAX, order::FILE_MAX), 200);
    let c = Consumers {
        sources: vec!["name search".into()],
        symbols: all,
        cut: 3,
        capped: 200,
        file: "/run/consumers.json".into(),
        ..Consumers::default()
    };
    assert!(lens_block(&c).unwrap().contains("200 more listed nowhere"));
    assert!(section(&c).contains("200 more line(s) past the 1000-line cap"));
}

#[test]
fn a_graph_caller_no_head_line_names_is_counted_not_listed() {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "fn m() {\n    call!(x);\n}\n");
    let c = build(
        &repo,
        &diff_of(&repo),
        Ok(graph(t.path(), "2099-01-01T00:00:00Z")),
    );
    let sites = &c.symbols[0].sites;
    assert!(!sites.iter().any(|s| s.line == 7), "{sites:?}");
    assert_eq!(c.graph_unlocated, 1);
    assert!(section(&c).contains("1 codebase-memory caller(s) not located in head"));
}

fn queries(t: &Path) -> Vec<String> {
    let log = std::fs::read_to_string(t.join("queries")).unwrap_or_default();
    log.lines().map(str::to_owned).collect()
}

#[test]
fn the_graph_is_asked_per_symbol_and_a_truncated_answer_is_said() {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "");
    let c = build(
        &repo,
        &diff_of(&repo),
        Ok(graph(t.path(), "2099-01-01T00:00:00Z")),
    );
    let asked = queries(t.path());
    // The cut symbol is asked once; `twice`, answered nothing, is asked for its test callers too.
    assert_eq!(asked.len(), 3, "{asked:?}");
    for q in &asked {
        assert_eq!(q.matches("f.name = '").count(), 1, "one name: {q}");
        assert!(q.contains("\"max_rows\":50"), "{q}");
    }
    assert_eq!(c.graph_truncated, vec!["k8s_rule_to_api"]);
    assert!(
        section(&c).contains(&format!("{GRAPH} callers cut at 50 for: k8s_rule_to_api")),
        "{}",
        section(&c)
    );
    assert!(lens_block(&c).unwrap().contains("k8s_rule_to_api"));
}
