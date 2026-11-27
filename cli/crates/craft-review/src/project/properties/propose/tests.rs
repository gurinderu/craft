//! What a repository's files offer: a library and whether it publishes, its rule files, its
//! controllers — each with the files it was read from.

use std::collections::BTreeMap;

use super::offered;

fn of(files: &[(&str, &str)]) -> super::Offered {
    let texts: BTreeMap<String, String> = files
        .iter()
        .map(|(f, t)| ((*f).to_owned(), (*t).to_owned()))
        .collect();
    let names: Vec<String> = texts.keys().cloned().collect();
    offered(&names, &|f| texts.get(f).cloned())
}

#[test]
fn a_crate_with_a_library_target_is_a_library_unless_it_publishes_nothing() {
    let lib = of(&[
        ("Cargo.toml", "[package]\nname = \"a\"\n"),
        ("src/lib.rs", ""),
    ]);
    let l = lib.library.unwrap();
    assert!(l.value);
    assert_eq!(l.from, ["Cargo.toml"]);
    let private = of(&[
        ("Cargo.toml", "[package]\nname = \"a\"\npublish = false\n"),
        ("src/lib.rs", ""),
    ]);
    assert_eq!(private.library.map(|l| l.value), Some(false));
    let bin = of(&[
        ("Cargo.toml", "[package]\nname = \"a\"\n"),
        ("src/main.rs", ""),
    ]);
    assert_eq!(bin.library.map(|l| l.value), Some(false));
    let declared = of(&[(
        "crates/x/Cargo.toml",
        "[package]\nname = \"x\"\n[lib]\npath = \"x.rs\"\n",
    )]);
    assert_eq!(declared.library.map(|l| l.value), Some(true));
    let workspace_only = of(&[("Cargo.toml", "[workspace]\nmembers = []\n")]);
    assert_eq!(
        workspace_only.library, None,
        "a manifest with no package says nothing"
    );
}

#[test]
fn a_package_json_is_a_library_unless_it_is_private_and_a_test_fixture_is_no_manifest() {
    assert_eq!(
        of(&[("package.json", "{\"name\":\"a\"}")])
            .library
            .map(|l| l.value),
        Some(true)
    );
    assert_eq!(
        of(&[("package.json", "{\"name\":\"a\",\"private\":true}")])
            .library
            .map(|l| l.value),
        Some(false)
    );
    assert_eq!(
        of(&[("tests/fixtures/package.json", "{\"name\":\"a\"}")]).library,
        None
    );
    assert_eq!(of(&[("README.md", "x")]).library, None);
}

#[test]
fn the_rule_files_at_the_top_are_offered_and_none_below_it() {
    let r = of(&[
        ("AGENTS.md", ""),
        ("CONTRIBUTING.md", ""),
        ("docs/CLAUDE.md", ""),
    ])
    .rules
    .unwrap();
    assert_eq!(r.value, ["AGENTS.md", "CONTRIBUTING.md"]);
    assert_eq!(of(&[("README.md", "")]).rules, None);
}

#[test]
fn a_kube_dependency_or_controller_runtime_makes_controllers() {
    let k = of(&[(
        "op/Cargo.toml",
        "[package]\nname = \"op\"\n[dependencies]\nkube = \"1\"\n",
    )]);
    assert_eq!(k.controllers.unwrap().from, ["op/Cargo.toml"]);
    let w = of(&[(
        "Cargo.toml",
        "[workspace.dependencies]\nkube-runtime = \"1\"\n",
    )]);
    assert!(w.controllers.is_some());
    let go = of(&[(
        "go.mod",
        "module x\nrequire sigs.k8s.io/controller-runtime v0.17.0\n",
    )]);
    assert!(go.controllers.is_some());
    let none = of(&[(
        "Cargo.toml",
        "[package]\nname = \"a\"\n[dependencies]\nkubelet = \"1\"\n",
    )]);
    assert_eq!(none.controllers, None);
}

#[test]
fn the_directories_named_for_security_are_offered_outermost_and_tests_left_out() {
    let o = of(&[
        ("src/auth/token.rs", ""),
        ("src/auth/session/s.rs", ""),
        ("crates/x/src/Crypto/k.rs", ""),
        ("tests/auth/t.rs", ""),
        ("src/authz.rs", ""),
    ]);
    assert_eq!(o.security_paths, ["crates/x/src/Crypto", "src/auth"]);
    let many: Vec<(String, &str)> = (0..9).map(|i| (format!("m{i}/auth/a.rs"), "")).collect();
    let many: Vec<(&str, &str)> = many.iter().map(|(f, t)| (f.as_str(), *t)).collect();
    assert!(
        of(&many).security_paths.is_empty(),
        "past the bound the names say too little"
    );
}
