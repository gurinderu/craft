use std::collections::BTreeMap;

use super::*;

fn pkg(root: &str, name: &str, sig: u64, deps: &[&str]) -> Package {
    Package {
        root: root.into(),
        name: name.into(),
        sig_lines: sig,
        deps: deps.iter().map(|d| (*d).to_owned()).collect(),
    }
}

fn files(prefix: &str, n: usize) -> Vec<String> {
    (0..n).map(|i| format!("{prefix}/src/f{i}.rs")).collect()
}

fn rust(f: &str) -> bool {
    f.ends_with(".rs") || f.ends_with("Cargo.toml")
}

#[test]
fn units_joined_by_a_dependency_share_a_batch_and_a_loose_file_keeps_its_slice() {
    let roots = vec![
        "crates/a".to_owned(),
        "crates/b".to_owned(),
        "crates/c".to_owned(),
    ];
    let packages = vec![
        pkg("crates/a", "a", 10, &[]),
        pkg("crates/b", "b", 5, &["a"]),
        pkg("crates/c", "c", 0, &[]),
    ];
    let numstat = BTreeMap::new();
    let g = Graph {
        roots: &roots,
        packages: &packages,
        numstat: &numstat,
    };
    let mut all = [
        files("crates/a", 5),
        files("crates/b", 5),
        files("crates/c", 2),
    ]
    .concat();
    all.extend(["Cargo.lock".to_owned(), "tools/x.rs".to_owned()]);
    let slices = batch_by_unit(&all, &g, BATCH_BUDGET, &rust);
    let keys: Vec<&str> = slices.iter().map(|s| s.key.as_str()).collect();
    assert_eq!(
        keys,
        [
            "unit:crates/a unit:crates/b",
            "unit:crates/c",
            "outside units"
        ]
    );
    assert_eq!(slices[0].units, ["crates/a", "crates/b"]);
    assert!(
        slices
            .iter()
            .all(|s| s.files.contains(&"Cargo.lock".to_owned()))
    );
    assert!(slices[2].units.is_empty());
}

#[test]
fn a_component_over_the_budget_is_grown_along_its_edges_and_a_large_unit_split_by_module() {
    let roots = vec!["a".to_owned(), "b".to_owned(), "c".to_owned()];
    let packages = vec![
        pkg("a", "a", 0, &[]),
        pkg("b", "b", 0, &["a"]),
        pkg("c", "c", 0, &["b"]),
    ];
    let numstat: BTreeMap<String, u64> = [files("a", 4), files("b", 4), files("c", 4)]
        .concat()
        .into_iter()
        .map(|f| (f, 100))
        .collect();
    let g = Graph {
        roots: &roots,
        packages: &packages,
        numstat: &numstat,
    };
    let all = [files("a", 4), files("b", 4), files("c", 4)].concat();
    let keys: Vec<String> = batch_by_unit(&all, &g, 800, &rust)
        .into_iter()
        .map(|s| s.key)
        .collect();
    assert_eq!(keys, ["unit:a unit:b", "unit:c"]);
    let mut big = files("a/m1", 6);
    big.extend(files("a/m2", 6));
    let numstat: BTreeMap<String, u64> = big.iter().map(|f| (f.clone(), 100)).collect();
    let roots = vec!["a".to_owned()];
    let g = Graph {
        roots: &roots,
        packages: &packages,
        numstat: &numstat,
    };
    let keys: Vec<String> = batch_by_unit(&big, &g, 700, &rust)
        .into_iter()
        .map(|s| s.key)
        .collect();
    assert_eq!(keys, ["unit:a//m1", "unit:a//m2"]);
}

#[test]
fn a_change_under_the_floor_is_not_sliced() {
    let roots = vec!["a".to_owned()];
    let packages = vec![pkg("a", "a", 0, &[])];
    let numstat = BTreeMap::new();
    let g = Graph {
        roots: &roots,
        packages: &packages,
        numstat: &numstat,
    };
    assert!(batch_by_unit(&files("a", 11), &g, BATCH_BUDGET, &rust).is_empty());
    assert_eq!(
        batch_by_unit(&files("a", 12), &g, BATCH_BUDGET, &rust).len(),
        1
    );
}
