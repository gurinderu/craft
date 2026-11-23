//! Which parts of a change the signal marks, read from real git trees: a directory the base had,
//! however deep its new children; a type the base already declares; each language's own public
//! spelling; data files; and the languages whose every file is a module.

use std::path::Path;

use super::mark;
use crate::git::Diff;
use crate::git::tests::git;
use crate::state::Track;

pub(crate) fn write(d: &Path, f: &str, text: &str) {
    let p = d.join(f);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, text).unwrap();
}

/// A repository holding `files` committed; its commit.
pub(crate) fn commit(d: &Path, files: &[(&str, &str)]) -> String {
    git(d, &["init", "-q", "-b", "main"]);
    for (f, t) in files {
        write(d, f, t);
    }
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "base"]);
    git(d, &["rev-parse", "HEAD"])
}

/// What the working tree, staged, changes against `rev`.
pub(crate) fn staged(d: &Path, rev: &str) -> Diff {
    git(d, &["add", "."]);
    let files = git(d, &["diff", "--name-only", rev]);
    Diff {
        base: rev.into(),
        merge_base: rev.into(),
        head: rev.into(),
        dirty: true,
        worktree: String::new(),
        files: files.lines().map(str::to_owned).collect(),
        stat: String::new(),
        log: String::new(),
    }
}

/// A repository holding `base` committed, then `head` written and staged; the diff between them.
pub(crate) fn change(d: &Path, base: &[(&str, &str)], head: &[(&str, &str)]) -> Diff {
    let rev = commit(d, base);
    for (f, t) in head {
        write(d, f, t);
    }
    staged(d, &rev)
}

/// Whether each of `parts` (profile, its files) is marked over the change.
fn marked(base: &[(&str, &str)], head: &[(&str, &str)], parts: &[(&str, &[&str])]) -> Vec<bool> {
    let t = tempfile::tempdir().unwrap();
    let diff = change(t.path(), base, head);
    let mut tracks: Vec<Track> = parts
        .iter()
        .map(|(p, fs)| Track::new(p, fs.iter().map(|f| (*f).to_owned()).collect()))
        .collect();
    mark(t.path(), &diff, &mut tracks);
    tracks.iter().map(|t| t.design).collect()
}

#[test]
fn a_directory_the_base_had_is_not_new_whatever_its_new_children() {
    let got = marked(
        &[("web/a/old.ts", "x\n")],
        &[("web/a/new.ts", "y\n"), ("web/a/b/lib.rs", "\n")],
        &[
            ("general", &["web/a/new.ts"]),
            ("rust", &["web/a/b/lib.rs"]),
        ],
    );
    assert_eq!(got, [false, true], "web/a was at the base, web/a/b was not");
}

#[test]
fn a_type_the_base_declares_is_not_new_when_edited_moved_or_reindented() {
    let base = [("a/src/lib.rs", "pub struct Old;\n"), ("a/src/x.rs", "\n")];
    let moved = [
        ("a/src/lib.rs", "\n"),
        (
            "a/src/x.rs",
            "    pub struct Old {\n        n: u8,\n    }\n",
        ),
    ];
    assert_eq!(
        marked(&base, &moved, &[("rust", &["a/src/lib.rs", "a/src/x.rs"])]),
        [false]
    );
    let fresh = [("a/src/lib.rs", "pub struct Old;\npub struct Ledger;\n")];
    assert_eq!(
        marked(&base, &fresh, &[("rust", &["a/src/lib.rs"])]),
        [true]
    );
}

#[test]
fn each_language_counts_only_its_own_public_spelling() {
    let base = [
        ("app/x.ts", "\n"),
        ("app/m.py", "\n"),
        ("app/t.go", "package app\n"),
    ];
    let cases: [(&str, &str, bool); 6] = [
        ("app/x.ts", "export enum Mode { A }\n", false),
        ("app/x.ts", "export interface Plan {}\n", true),
        ("app/m.py", "class _Hidden:\n    pass\n", false),
        ("app/m.py", "class Ledger:\n    pass\n", true),
        (
            "app/t.go",
            "package app\ntype (\n\tLedger struct{}\n)\n",
            true,
        ),
        ("app/t.go", "package app\ntype ledger struct{}\n", false),
    ];
    for (f, text, want) in cases {
        let got = marked(&base, &[(f, text)], &[("general", &[f])]);
        assert_eq!(got, [want], "{f}: {text}");
    }
}

#[test]
fn a_data_file_is_no_module_and_a_python_or_nix_file_always_is() {
    let base = [("app/main.py", "\n"), ("nix/a.nix", "{}\n")];
    for (f, want) in [
        ("app/data/rows.json", false),
        ("app/notes/list.txt", false),
        ("app/extra.py", true),
        ("nix/b.nix", true),
    ] {
        let got = marked(&base, &[(f, "{}\n")], &[("general", &[f])]);
        assert_eq!(got, [want], "{f}");
    }
}
