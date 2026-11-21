//! A file's place in the workspace, and where a path's first segment leads from it.

use std::collections::BTreeSet;

use super::{Package, Root, Workspace};

fn package(dir: &str, lib: &str, deps: &[&str]) -> Package {
    Package {
        dir: dir.into(),
        lib: lib.into(),
        deps: deps
            .iter()
            .map(|d| (*d).to_owned())
            .collect::<BTreeSet<_>>(),
    }
}

fn ws() -> Workspace {
    Workspace::of(vec![
        package("a", "a", &["metrics", "b"]),
        package("b", "b", &[]),
        package("b/nested", "nested", &[]),
    ])
}

#[test]
fn a_file_s_crate_and_module_follow_its_package_and_path() {
    let ws = ws();
    let at = |f: &str| {
        let u = ws.unit(f);
        (u.krate, u.module.join("::"))
    };
    assert_eq!(at("a/src/lib.rs"), ("a".into(), String::new()));
    assert_eq!(at("a/src/x/y.rs"), ("a".into(), "x::y".into()));
    assert_eq!(at("a/src/x/mod.rs"), ("a".into(), "x".into()));
    assert_eq!(at("b/nested/src/main.rs"), ("nested".into(), String::new()));
    assert_eq!(at("a/tests/it.rs"), ("a/tests/it.rs".into(), String::new()));
    assert_eq!(
        at("a/src/bin/tool.rs"),
        ("a/src/bin/tool.rs".into(), String::new())
    );
    assert_eq!(at("src/m.rs"), (String::new(), "m".into()));
    assert_eq!(
        ws.files_of("a", &["x".into()]),
        ["a/src/x.rs", "a/src/x/mod.rs"]
    );
    assert_eq!(ws.files_of("", &[]), ["src/lib.rs", "src/main.rs"]);
}

#[test]
fn a_root_is_external_only_to_a_crate_depending_on_it() {
    let ws = ws();
    let a = ws.unit("a/src/lib.rs");
    let b = ws.unit("b/src/lib.rs");
    assert_eq!(a.root("metrics"), Root::Out);
    assert_eq!(b.root("metrics"), Root::Here);
    assert_eq!(a.root("b"), Root::Crate("b".into()));
    assert_eq!(b.root("b"), Root::Here);
    assert_eq!(ws.unit("b/tests/it.rs").root("b"), Root::Crate("b".into()));
    assert_eq!(b.root("nested"), Root::Here);
    assert_eq!(b.root("std"), Root::Out);
    assert_eq!(b.root("::"), Root::Out);
}
