//! The structural search's reach past the owner's own name (realm @nick/craft, #564): a free
//! function by its module and imports, a trait's item through an implementing type, a type by
//! its full module path — each with a same-named item elsewhere that must not match.

use std::path::Path;

use super::{diff_of, git, no_graph};
use crate::consumers::{STRUCTURAL, build};

/// A repository on `main` holding `files`, whose change rewrites `file` from the first text of
/// `edit` to the second.
pub(super) fn repo(
    t: &Path,
    files: &[(&str, &str)],
    (file, edit): (&str, (&str, &str)),
) -> std::path::PathBuf {
    let repo = t.join("repo");
    git(t, &["init", "-q", "-b", "main", "repo"]);
    for (path, text) in files {
        let at = repo.join(path);
        std::fs::create_dir_all(at.parent().unwrap()).unwrap();
        std::fs::write(at, text).unwrap();
    }
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "init"]);
    git(&repo, &["branch", "base"]);
    let text = std::fs::read_to_string(repo.join(file)).unwrap();
    std::fs::write(repo.join(file), text.replace(edit.0, edit.1)).unwrap();
    git(&repo, &["commit", "-qam", "feat: change"]);
    repo
}

/// The structural lines listed for `name`, `file:line` each.
pub(super) fn found(repo: &Path, name: &str) -> Vec<String> {
    let c = build(repo, &diff_of(repo), no_graph());
    let mut at: Vec<String> = c
        .symbols
        .iter()
        .filter(|s| s.name == name)
        .flat_map(|s| s.sites.iter())
        .filter(|s| s.from.iter().any(|f| f == STRUCTURAL))
        .map(|s| format!("{}:{}", s.file, s.line))
        .collect();
    at.sort();
    at
}

#[test]
fn a_free_function_is_reached_by_its_module_and_imports_not_a_same_named_one() {
    let t = tempfile::tempdir().unwrap();
    let handlers = "pub fn update() -> u8 {\n    1\n}\n#[cfg(test)]\nmod tests {\n    use super::*;\n    fn t() { update(); }\n}\n";
    let routes = "use crate::handlers;\nuse crate::other::update;\nfn a() { routing::put(handlers::update); }\nfn b() { crate::handlers::update(); }\nfn c() { update(); }\nfn d() { crate::other::update(); }\n";
    let files = [
        (
            "src/lib.rs",
            "pub mod handlers;\npub mod other;\nmod routes;\nmod api;\n",
        ),
        ("src/handlers.rs", handlers),
        (
            "src/other.rs",
            "pub fn update() -> u8 {\n    3\n}\nfn own() { update(); }\n",
        ),
        ("src/routes.rs", routes),
        (
            "src/api.rs",
            "use crate::handlers::update;\nfn e() { routing::put(update); }\n",
        ),
    ];
    let repo = repo(
        t.path(),
        &files,
        ("src/handlers.rs", ("    1\n", "    2\n")),
    );
    assert_eq!(
        found(&repo, "update"),
        [
            "src/api.rs:2",
            "src/handlers.rs:7",
            "src/routes.rs:3",
            "src/routes.rs:4"
        ]
    );
}

#[test]
fn a_trait_s_item_is_reached_through_a_type_implementing_it_not_another_type() {
    let t = tempfile::tempdir().unwrap();
    let lib = "pub mod uses;\npub trait Store {\n    fn update(&self) -> u8 {\n        1\n    }\n}\npub struct Disk;\nimpl Store for Disk {}\npub struct Mem;\nimpl Mem {\n    pub fn update(&self) -> u8 { 0 }\n}\n";
    let uses =
        "use crate::{Disk, Mem};\nfn f() {\n    Disk::update(&Disk);\n    Mem::update(&Mem);\n}\n";
    let files = [("src/lib.rs", lib), ("src/uses.rs", uses)];
    let repo = repo(
        t.path(),
        &files,
        ("src/lib.rs", ("        1\n", "        2\n")),
    );
    assert_eq!(found(&repo, "update"), ["src/uses.rs:3"]);
}

#[test]
fn a_type_is_told_from_a_same_named_one_in_another_module_by_its_full_path() {
    let t = tempfile::tempdir().unwrap();
    let ty = |n: u8| {
        format!("pub struct T;\nimpl T {{\n    pub fn new() -> u8 {{\n        {n}\n    }}\n}}\n")
    };
    let b = format!("{}pub fn g() -> u8 {{ T::new() }}\n", ty(5));
    let uses = "use crate::b::T;\nfn f() {\n    crate::a::T::new();\n    crate::b::T::new();\n    T::new();\n    super::a::T::new();\n}\n";
    let a = ty(1);
    let files = [
        ("src/lib.rs", "pub mod a;\npub mod b;\nmod uses;\n"),
        ("src/a.rs", a.as_str()),
        ("src/b.rs", b.as_str()),
        ("src/uses.rs", uses),
    ];
    let repo = repo(
        t.path(),
        &files,
        ("src/a.rs", ("        1\n", "        2\n")),
    );
    assert_eq!(found(&repo, "new"), ["src/uses.rs:3", "src/uses.rs:6"]);
}
