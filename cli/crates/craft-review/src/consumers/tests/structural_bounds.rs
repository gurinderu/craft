//! The structural search's resolution at its edges (realm @nick/craft, #564): a binary target
//! reaching its package's library by name, an `impl` of a type a glob brings in, the standard
//! prelude's names, a workspace whose manifests could not be read, and a free function's files
//! past the search's cap.

use super::structural_gaps::{found, repo};
use super::{diff_of, no_graph};
use crate::consumers::build;

const X: &str = "pub struct X;\nimpl X {\n    pub fn new() -> u8 {\n        1\n    }\n}\n";

#[test]
fn a_binary_reaches_its_package_s_library_by_the_library_s_name() {
    let t = tempfile::tempdir().unwrap();
    let main = "use mylib::X;\nfn main() {\n    X::new();\n    mylib::X::new();\n}\n";
    let files = [
        ("Cargo.toml", "[package]\nname = \"mylib\"\n"),
        ("src/lib.rs", X),
        ("src/main.rs", main),
    ];
    let repo = repo(
        t.path(),
        &files,
        ("src/lib.rs", ("        1\n", "        2\n")),
    );
    assert_eq!(found(&repo, "new"), ["src/main.rs:3", "src/main.rs:4"]);
}

#[test]
fn an_impl_of_a_type_a_glob_brings_in_is_the_type_s_own() {
    let t = tempfile::tempdir().unwrap();
    let imp = "use super::*;\nimpl Foo {\n    pub fn new() -> u8 {\n        1\n    }\n}\n";
    let files = [
        ("src/lib.rs", "pub mod a;\nmod uses;\n"),
        ("src/a.rs", "pub struct Foo;\nmod imp;\n"),
        ("src/a/imp.rs", imp),
        ("src/uses.rs", "fn f() {\n    crate::a::Foo::new();\n}\n"),
    ];
    let repo = repo(
        t.path(),
        &files,
        ("src/a/imp.rs", ("        1\n", "        2\n")),
    );
    assert_eq!(found(&repo, "new"), ["src/uses.rs:2"]);
}

#[test]
fn a_prelude_type_is_no_owner_unless_the_crate_declares_it() {
    let t = tempfile::tempdir().unwrap();
    let lib = "pub trait Grow {\n    fn new() -> Self;\n}\nimpl Grow for Vec<u8> {\n    fn new() -> Self {\n        vec![1]\n    }\n}\nfn f() {\n    let v: Vec<u8> = Vec::new();\n}\n";
    let files = [("src/lib.rs", lib)];
    let shared = repo(t.path(), &files, ("src/lib.rs", ("vec![1]", "vec![2]")));
    assert_eq!(found(&shared, "new"), Vec::<String>::new());
    let own = "pub struct Vec;\nimpl Vec {\n    pub fn new() -> u8 {\n        1\n    }\n}\nfn f() -> u8 {\n    Vec::new()\n}\n";
    let t = tempfile::tempdir().unwrap();
    let declared = repo(
        t.path(),
        &[("src/lib.rs", own)],
        ("src/lib.rs", ("        1\n", "        2\n")),
    );
    assert_eq!(found(&declared, "new"), ["src/lib.rs:8"]);
}

#[test]
fn a_workspace_not_read_is_said_and_falls_back_to_the_owner_s_last_segment() {
    let t = tempfile::tempdir().unwrap();
    let lib = format!("{X}pub fn run() -> u8 {{\n        1\n}}\n");
    let uses =
        "use crate::X;\nfn f() {\n    X::new();\n    other::X::new();\n    crate::run();\n}\n";
    let manifests: Vec<(String, &str)> = (0..=500)
        .map(|i| (format!("m{i}/Cargo.toml"), ""))
        .collect();
    let mut files: Vec<(&str, &str)> = vec![("src/lib.rs", &lib), ("src/uses.rs", uses)];
    files.extend(manifests.iter().map(|(p, s)| (p.as_str(), *s)));
    let repo = repo(
        t.path(),
        &files,
        ("src/lib.rs", ("        1\n", "        2\n")),
    );
    assert_eq!(found(&repo, "new"), ["src/uses.rs:3", "src/uses.rs:4"]);
    let c = build(&repo, &diff_of(&repo), no_graph());
    let said: Vec<&String> = c
        .unsearched
        .iter()
        .filter(|u| u.starts_with("structural search:"))
        .collect();
    assert_eq!(said.len(), 1, "{:?}", c.unsearched);
    assert!(said[0].contains("manifests"), "{said:?}");
    assert!(
        c.unsearched.iter().any(|u| u == "run"),
        "{:?}",
        c.unsearched
    );
}

#[test]
fn a_free_function_s_files_past_the_cap_are_not_read_and_said() {
    let t = tempfile::tempdir().unwrap();
    let cap = crate::consumers::names::FREE_FILES_MAX;
    let lib = "pub mod h;\n".to_owned();
    let calls: Vec<(String, String)> = (0..=cap)
        .map(|i| {
            (
                format!("src/c{i}.rs"),
                "fn f() { other::update(); }\n".to_owned(),
            )
        })
        .collect();
    let mut files: Vec<(&str, &str)> = vec![
        ("src/lib.rs", &lib),
        ("src/h.rs", "pub fn update() -> u8 {\n    1\n}\n"),
    ];
    files.extend(calls.iter().map(|(p, s)| (p.as_str(), s.as_str())));
    let repo = repo(t.path(), &files, ("src/h.rs", ("    1\n", "    2\n")));
    let c = build(&repo, &diff_of(&repo), no_graph());
    let note = c
        .unsearched
        .iter()
        .find(|u| u.starts_with("update"))
        .unwrap();
    assert!(
        note.contains(&format!("{cap} of {} files read", cap + 2)),
        "{note}"
    );
}
