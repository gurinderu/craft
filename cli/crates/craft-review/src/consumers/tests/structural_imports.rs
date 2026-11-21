//! The structural search's reading of crates and imports (realm @nick/craft, #564): a path is
//! external only to a crate depending on its root, and `{self as x}` and glob imports are read —
//! each with a same-named item elsewhere that must not match.

use super::structural_gaps::{found, repo};

const T: &str = "pub struct T;\nimpl T {\n    pub fn new() -> u8 {\n        1\n    }\n}\n";

#[test]
fn a_local_module_named_like_another_crate_s_dependency_is_not_external() {
    let t = tempfile::tempdir().unwrap();
    let files = [
        ("Cargo.toml", "[workspace]\nmembers = [\"a\", \"b\"]\n"),
        (
            "a/Cargo.toml",
            "[package]\nname = \"a\"\n[dependencies]\nmetrics = \"0.1\"\n",
        ),
        ("a/src/lib.rs", "pub fn f() {\n    metrics::T::new();\n}\n"),
        ("b/Cargo.toml", "[package]\nname = \"b\"\n"),
        (
            "b/src/lib.rs",
            "pub mod metrics;\npub fn g() -> u8 {\n    metrics::T::new()\n}\n",
        ),
        ("b/src/metrics.rs", T),
    ];
    let repo = repo(
        t.path(),
        &files,
        ("b/src/metrics.rs", ("        1\n", "        2\n")),
    );
    assert_eq!(found(&repo, "new"), ["b/src/lib.rs:3"]);
}

#[test]
fn a_self_alias_and_a_glob_import_are_read_and_reach_only_their_module() {
    let t = tempfile::tempdir().unwrap();
    let other = "pub struct T;\nimpl T {\n    pub fn new() -> u8 { 0 }\n}\npub fn update() {}\n";
    let files = [
        (
            "src/lib.rs",
            "pub mod store;\npub mod other;\nmod alias;\nmod glob;\nmod neg;\n",
        ),
        ("src/store.rs", "pub fn update() -> u8 {\n    1\n}\n"),
        ("src/other.rs", other),
        (
            "src/alias.rs",
            "use crate::store::{self as s};\nfn f() {\n    s::update();\n}\n",
        ),
        (
            "src/glob.rs",
            "use crate::store::*;\nfn g() {\n    update();\n}\n",
        ),
        (
            "src/neg.rs",
            "use crate::other::*;\nuse crate::other::{self as s};\nfn h() {\n    update();\n    s::update();\n}\n",
        ),
    ];
    let repo = repo(t.path(), &files, ("src/store.rs", ("    1\n", "    2\n")));
    assert_eq!(found(&repo, "update"), ["src/alias.rs:3", "src/glob.rs:3"]);
}

#[test]
fn a_self_alias_of_an_external_module_does_not_reach_a_same_named_type() {
    let t = tempfile::tempdir().unwrap();
    let uses = "use std::io::{self as sio};\nuse crate::Error;\nfn f() {\n    sio::Error::new();\n    Error::new();\n}\n";
    let error = T
        .replace("struct T", "struct Error")
        .replace("impl T", "impl Error");
    let files = [
        ("src/lib.rs", format!("mod uses;\n{error}")),
        ("src/uses.rs", uses.to_owned()),
    ];
    let files: Vec<(&str, &str)> = files.iter().map(|(p, s)| (*p, s.as_str())).collect();
    let repo = repo(
        t.path(),
        &files,
        ("src/lib.rs", ("        1\n", "        2\n")),
    );
    assert_eq!(found(&repo, "new"), ["src/uses.rs:5"]);
}
