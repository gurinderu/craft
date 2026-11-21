use super::delta::{edges, lines};
use super::mark;
use super::mark_tests::change;
use crate::state::Track;

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
            "new cycle: c -> a -> b -> c, through the dev-dependency edge(s) c -> a — legal in Cargo: a test, bench or example depending back",
        ]
    );
    assert!(
        lines(&head, &head).is_empty(),
        "an unchanged graph: no delta"
    );
}

#[test]
fn every_dev_edge_on_the_cycle_is_named_and_a_cycle_of_normal_edges_is_not_claimed() {
    let base = edges(&[
        manifest("a", &[], &["b"]),
        manifest("b", &[], &[]),
        manifest("c", &[], &[]),
    ]);
    let head = edges(&[
        manifest("a", &[], &["b"]),
        manifest("b", &["c"], &[]),
        manifest("c", &[], &["a"]),
    ]);
    let got = lines(&base, &head);
    assert_eq!(
        got.last().unwrap(),
        "new cycle: b -> c -> a -> b, through the dev-dependency edge(s) c -> a, a -> b — legal in Cargo: a test, bench or example depending back"
    );
    let normal = edges(&[manifest("a", &["b"], &[]), manifest("b", &["a"], &[])]);
    let got = lines(&edges(&[]), &normal);
    assert_eq!(
        got,
        ["new edge: a -> b", "new edge: b -> a"],
        "Cargo refuses to build it: no cycle line"
    );
}

#[test]
fn the_crate_delta_reads_the_workspace_members_only() {
    let t = tempfile::tempdir().unwrap();
    let d = t.path();
    let ws = "[workspace]\nmembers = [\"crates/*\"]\nexclude = [\"crates/skip\"]\n";
    let pkg = |n: &str, dep: &str| format!("[package]\nname = \"{n}\"\n[dependencies]\n{dep}");
    let diff = change(
        d,
        &[
            ("Cargo.toml", ws),
            ("crates/a/Cargo.toml", &pkg("a", "")),
            ("crates/a/src/lib.rs", "\n"),
        ],
        &[
            (
                "crates/b/Cargo.toml",
                &pkg("b", "a = { path = \"../a\" }\n"),
            ),
            ("crates/b/src/lib.rs", "\n"),
            (
                "crates/skip/Cargo.toml",
                &pkg("skip", "a = { path = \"../a\" }\n"),
            ),
        ],
    );
    let files = [
        "crates/b/Cargo.toml",
        "crates/b/src/lib.rs",
        "crates/skip/Cargo.toml",
    ];
    let mut tracks = vec![Track::new(
        "rust",
        files.iter().map(|f| (*f).to_owned()).collect(),
    )];
    let (seed, _) = mark(d, &diff, &mut tracks);
    assert_eq!(seed.crates, ["new edge: b -> a"], "crates/skip is excluded");
}
