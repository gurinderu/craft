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

#[test]
fn a_crate_inheriting_publish_false_from_its_workspace_or_publishing_to_no_registry_is_none() {
    let root = "[workspace]\nmembers = [\"crates/*\"]\n[workspace.package]\npublish = false\n";
    let member = "[package]\nname = \"x\"\npublish.workspace = true\n";
    let o = of(&[
        ("Cargo.toml", root),
        ("crates/x/Cargo.toml", member),
        ("crates/x/src/lib.rs", ""),
    ]);
    assert_eq!(o.library.map(|l| l.value), Some(false));
    let open = root.replace("publish = false", "publish = true");
    let o = of(&[
        ("Cargo.toml", &open),
        ("crates/x/Cargo.toml", member),
        ("crates/x/src/lib.rs", ""),
    ]);
    assert_eq!(o.library.map(|l| l.value), Some(true));
    let none = of(&[
        ("Cargo.toml", "[package]\nname = \"a\"\npublish = []\n"),
        ("src/lib.rs", ""),
    ]);
    assert_eq!(none.library.map(|l| l.value), Some(false));
    let elsewhere = of(&[
        ("crates/x/Cargo.toml", "[package]\nname = \"x\"\n"),
        ("src/lib.rs", ""),
    ]);
    assert_eq!(
        elsewhere.library.map(|l| l.value),
        Some(false),
        "its own src/lib.rs, not the top's"
    );
}

#[test]
fn vendored_code_offers_nothing() {
    let o = of(&[
        ("Cargo.toml", "[package]\nname = \"app\"\n"),
        ("src/main.rs", ""),
        (
            "vendor/kube/Cargo.toml",
            "[package]\nname = \"k\"\n[dependencies]\nkube = \"1\"\n",
        ),
        ("vendor/kube/src/lib.rs", ""),
        ("third_party/x/auth/a.go", ""),
        ("internal/auth/a.go", ""),
    ]);
    assert_eq!(o.library.map(|l| l.value), Some(false));
    assert_eq!(o.controllers, None);
    assert_eq!(o.security_paths, ["internal/auth"]);
}

#[test]
fn up_to_the_bound_of_security_directories_each_is_offered() {
    let names: Vec<String> = (0..8).map(|i| format!("m{i}/auth/a.rs")).collect();
    let files: Vec<(&str, &str)> = names.iter().map(|f| (f.as_str(), "")).collect();
    assert_eq!(of(&files).security_paths.len(), 8);
}
