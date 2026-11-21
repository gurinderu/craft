use super::signal::*;

fn part<'a>(rust: bool, files: &'a [String], added: &'a [String]) -> Part<'a> {
    Part { rust, files, added }
}

fn owned(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| (*s).to_owned()).collect()
}

/// [`reasons`] with `lines` for each file's added lines, `new_dir` for the base's directories and
/// no type declared at the base.
fn reasons_of(
    part: &Part<'_>,
    lines: &dyn Fn(&str) -> Vec<(u32, String)>,
    new_dir: &dyn Fn(&str) -> bool,
) -> Vec<String> {
    let ask = Lookups {
        added_lines: lines,
        new_dir,
        declared: &|_| false,
    };
    reasons(part, &ask)
}

#[test]
fn the_files_a_diff_creates_are_its_new_file_headers_only() {
    let diff = "diff --git a/src/a.rs b/src/a.rs\nnew file mode 100644\nindex 0..1\n--- /dev/null\n+++ b/src/a.rs\n@@ -0,0 +1 @@\n+fn a() {}\ndiff --git a/src/b.rs b/src/b.rs\nindex 1..2 100644\n--- a/src/b.rs\n+++ b/src/b.rs\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/old.rs b/moved.rs\nsimilarity index 100%\nrename from old.rs\nrename to moved.rs\n";
    assert_eq!(added_files(diff), ["src/a.rs"]);
}

#[test]
fn a_new_crate_module_format_or_public_type_fires() {
    let files = owned(&[
        "cli/x/Cargo.toml",
        "cli/x/src/lib.rs",
        "api/v1.proto",
        "src/old.rs",
    ]);
    let added = owned(&["cli/x/Cargo.toml", "cli/x/src/lib.rs", "api/v1.proto"]);
    let lines = |f: &str| {
        if f == "src/old.rs" {
            vec![
                (7, "pub struct Ledger {".to_owned()),
                (9, "    mod inner {".to_owned()),
            ]
        } else {
            vec![]
        }
    };
    let got = reasons_of(&part(true, &files, &added), &lines, &|_| false);
    assert_eq!(
        got,
        [
            "new crate: cli/x/Cargo.toml",
            "new module: cli/x/src/lib.rs",
            "new format: api/v1.proto",
            "new public type: Ledger at src/old.rs:7",
            "new module: mod inner at src/old.rs:9",
        ]
    );
}

#[test]
fn edits_private_items_tests_and_files_in_old_directories_do_not_fire() {
    let files = owned(&["src/a.rs", "src/a/tests.rs", "tests/it.rs"]);
    let added = owned(&["src/a/tests.rs", "tests/it.rs"]);
    let lines = |_: &str| {
        vec![
            (1, "struct Private;".to_owned()),
            (2, "pub(crate) struct Inner;".to_owned()),
            (3, "pub fn f() {}".to_owned()),
            (4, "mod tests {".to_owned()),
            (5, "let x = \"pub struct Fake\";".to_owned()),
        ]
    };
    assert!(reasons_of(&part(true, &files, &added), &lines, &|_| true).is_empty());
    // Outside Rust a new source file counts only in a directory the base lacked.
    let files = owned(&["app/util.ts"]);
    let none = |_: &str| vec![];
    assert!(reasons_of(&part(false, &files, &files), &none, &|_| false).is_empty());
    assert_eq!(
        reasons_of(&part(false, &files, &files), &none, &|d| d == "app"),
        ["new module: app/util.ts"]
    );
    // An inline module is a Rust signal only.
    let lines = |_: &str| vec![(1, "mod inner {".to_owned())];
    assert!(reasons_of(&part(false, &files, &[]), &lines, &|_| true).is_empty());
}

#[test]
fn a_type_the_base_declares_is_no_new_type() {
    let files = owned(&["src/a.rs"]);
    let lines = |_: &str| {
        vec![
            (2, "pub struct Old;".to_owned()),
            (3, "pub struct New;".to_owned()),
        ]
    };
    let ask = Lookups {
        added_lines: &lines,
        new_dir: &|_| false,
        declared: &|t| t == "Old",
    };
    assert_eq!(
        reasons(&part(true, &files, &[]), &ask),
        ["new public type: New at src/a.rs:3"]
    );
}

#[test]
fn a_format_is_an_interface_language_a_schema_or_an_api_description() {
    for f in [
        "a/b.proto",
        "x.graphql",
        "content/schemas/scout.json",
        "a/user.schema.json",
        "openapi.yaml",
    ] {
        assert!(is_format(f), "{f}");
    }
    for f in ["package.json", "src/data.json", "config.yaml", "schemas.rs"] {
        assert!(!is_format(f), "{f}");
    }
}
