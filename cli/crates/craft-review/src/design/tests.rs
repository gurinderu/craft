use std::path::Path;

use super::mark;
use crate::git::Diff;
use crate::git::tests::git;
use crate::state::Track;

fn write(d: &Path, f: &str, text: &str) {
    let p = d.join(f);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, text).unwrap();
}

fn diff_of(d: &Path, base: &str) -> Diff {
    let files = git(d, &["diff", "--name-only", base]);
    Diff {
        base: base.into(),
        merge_base: base.into(),
        head: base.into(),
        dirty: true,
        worktree: String::new(),
        files: files.lines().map(str::to_owned).collect(),
        stat: String::new(),
        log: String::new(),
    }
}

/// A workspace of two crates, `a` depending on `b`, committed.
fn workspace(d: &Path) -> String {
    git(d, &["init", "-q", "-b", "main"]);
    write(d, "Cargo.toml", "[workspace]\nmembers = [\"a\", \"b\"]\n");
    write(
        d,
        "a/Cargo.toml",
        "[package]\nname = \"a\"\n[dependencies]\nb = { path = \"../b\" }\n",
    );
    write(d, "a/src/lib.rs", "fn private() {}\n");
    write(d, "b/Cargo.toml", "[package]\nname = \"b\"\n");
    write(d, "b/src/lib.rs", "\n");
    write(d, "app/main.py", "x = 1\n");
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "base"]);
    git(d, &["rev-parse", "HEAD"])
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
    git(d, &["add", "."]);
    let diff = diff_of(d, &base);
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
        seed.structure,
        [
            "new crate: c/Cargo.toml",
            "new module: c/src/lib.rs",
            "new public type: Plan at c/src/lib.rs:1"
        ]
    );
    assert_eq!(
        seed.crates,
        [
            "new edge: b -> c (dev-dependency)",
            "new edge: c -> a",
            "new cycle: b -> c -> a -> b (closed by the new edge b -> c (dev-dependency))",
        ]
    );
}

#[test]
fn a_new_directory_of_other_source_marks_the_general_track_and_reads_no_crate_graph() {
    let t = tempfile::tempdir().unwrap();
    let d = t.path();
    let base = workspace(d);
    write(d, "billing/ledger.py", "def f():\n    pass\n");
    write(d, "app/helpers.py", "def g():\n    pass\n");
    git(d, &["add", "."]);
    let diff = diff_of(d, &base);
    let mut tracks = vec![Track::new(
        "general",
        vec!["app/helpers.py".into(), "billing/ledger.py".into()],
    )];
    let (seed, _) = mark(d, &diff, &mut tracks);
    assert!(tracks[0].design);
    assert_eq!(
        seed.structure,
        ["new module: billing/ledger.py, in the new directory billing"],
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
