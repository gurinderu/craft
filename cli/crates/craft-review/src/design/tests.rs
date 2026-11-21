use std::path::Path;

use super::mark;
use super::mark_tests::{commit, staged, write};
use crate::git::Diff;
use crate::state::Track;

/// A workspace of two crates, `a` depending on `b`, committed.
fn workspace(d: &Path) -> String {
    write(
        d,
        "Cargo.toml",
        "[workspace]\nmembers = [\"a\", \"b\", \"c\"]\n",
    );
    write(
        d,
        "a/Cargo.toml",
        "[package]\nname = \"a\"\n[dependencies]\nb = { path = \"../b\" }\n",
    );
    write(d, "a/src/lib.rs", "fn private() {}\n");
    write(d, "b/Cargo.toml", "[package]\nname = \"b\"\n");
    write(d, "b/src/lib.rs", "\n");
    write(d, "app/main.py", "x = 1\n");
    write(d, "app/main.ts", "x\n");
    commit(d, &[])
}

#[test]
fn a_new_crate_with_a_cycle_marks_the_rust_track_and_seeds_the_delta() {
    let t = tempfile::tempdir().unwrap();
    let d = t.path();
    let base = workspace(d);
    write(
        d,
        "c/Cargo.toml",
        "[package]\nname = \"c\"\n[dependencies]\na = { path = \"../a\" }\n",
    );
    write(d, "c/src/lib.rs", "pub struct Plan;\n");
    write(
        d,
        "b/Cargo.toml",
        "[package]\nname = \"b\"\n[dev-dependencies]\nc = { path = \"../c\" }\n",
    );
    write(d, "app/main.py", "x = 2\n");
    let diff = staged(d, &base);
    let mut tracks = vec![
        Track::new(
            "rust",
            vec![
                "b/Cargo.toml".into(),
                "c/Cargo.toml".into(),
                "c/src/lib.rs".into(),
            ],
        ),
        Track::new("general", vec!["app/main.py".into()]),
    ];
    let (seed, note) = mark(d, &diff, &mut tracks);
    assert_eq!(note, None);
    assert!(tracks[0].design, "{seed:?}");
    assert!(
        !tracks[1].design,
        "an edit of an old file adds no structure"
    );
    assert_eq!(
        seed.structure["rust"],
        [
            "new crate: c/Cargo.toml",
            "new module: c/src/lib.rs",
            "new public type: Plan at c/src/lib.rs:1"
        ]
    );
    assert!(!seed.structure.contains_key("general"));
    assert_eq!(
        seed.crates,
        [
            "new edge: b -> c (dev-dependency)",
            "new edge: c -> a",
            "new cycle: b -> c -> a -> b, through the dev-dependency edge(s) b -> c — legal in Cargo: a test, bench or example depending back",
        ]
    );
}

#[test]
fn a_new_directory_of_other_source_marks_the_general_track_and_reads_no_crate_graph() {
    let t = tempfile::tempdir().unwrap();
    let d = t.path();
    let base = workspace(d);
    write(d, "billing/ledger.ts", "const f = 1;\n");
    write(d, "app/helpers.ts", "const g = 1;\n");
    let diff = staged(d, &base);
    let mut tracks = vec![Track::new(
        "general",
        vec!["app/helpers.ts".into(), "billing/ledger.ts".into()],
    )];
    let (seed, _) = mark(d, &diff, &mut tracks);
    assert!(tracks[0].design);
    assert_eq!(
        seed.structure["general"],
        ["new module: billing/ledger.ts"],
        "app/ was at the base"
    );
    assert!(seed.crates.is_empty() && seed.note.is_empty());
}

#[test]
fn a_change_that_cannot_be_read_marks_none_and_says_so() {
    let t = tempfile::tempdir().unwrap();
    let diff = Diff {
        base: "origin/main".into(),
        merge_base: "origin/main".into(),
        head: String::new(),
        dirty: false,
        worktree: String::new(),
        files: vec![],
        stat: String::new(),
        log: String::new(),
    };
    let mut tracks = vec![Track::new("rust", vec!["src/a.rs".into()])];
    let (seed, note) = mark(t.path(), &diff, &mut tracks);
    assert!(note.unwrap().contains("design signal could not be read"));
    assert!(!tracks[0].design && seed.is_empty());
}
