use super::delta::{edges, lines};

fn manifest(name: &str, deps: &[&str], dev: &[&str]) -> String {
    let list = |ds: &[&str]| {
        ds.iter()
            .map(|d| format!("{d} = {{ path = \"../{d}\" }}\n"))
            .collect::<String>()
    };
    format!(
        "[package]\nname = \"{name}\"\n[dependencies]\nserde = \"1\"\n{}[dev-dependencies]\n{}",
        list(deps),
        list(dev)
    )
}

#[test]
fn the_edges_are_among_workspace_packages_only_a_dev_one_marked() {
    let got = edges(&[
        manifest("craft-review", &["craft-store"], &["test-support"]),
        manifest("craft-store", &[], &[]),
        manifest("test-support", &[], &[]),
        "[workspace]\nmembers = []\n".into(),
        "not toml".into(),
    ]);
    let got: Vec<_> = got.into_iter().collect();
    assert_eq!(
        got,
        [
            (("craft_review".into(), "craft_store".into()), false),
            (("craft_review".into(), "test_support".into()), true),
        ]
    );
}

#[test]
fn a_new_edge_is_named_and_the_cycle_it_closes_too() {
    let base = edges(&[
        manifest("a", &["b"], &[]),
        manifest("b", &["c"], &[]),
        manifest("c", &[], &[]),
    ]);
    let head = edges(&[
        manifest("a", &["b"], &[]),
        manifest("b", &["c"], &[]),
        manifest("c", &[], &["a"]),
        manifest("d", &["a"], &[]),
    ]);
    assert_eq!(
        lines(&base, &head),
        [
            "new edge: c -> a (dev-dependency)",
            "new edge: d -> a",
            "new cycle: c -> a -> b -> c (closed by the new edge c -> a (dev-dependency))",
        ]
    );
    assert!(
        lines(&head, &head).is_empty(),
        "an unchanged graph: no delta"
    );
}
