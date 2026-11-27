//! The bucket at its bounds, git's numstat read per new path, and each track marked by its files.

use std::process::Command;

use super::{LARGE_ABOVE, SMALL_BELOW, bucket, counted, mark, parse, scout_schema, told};
use crate::state::Track;

#[test]
fn the_bucket_turns_at_its_bounds() {
    assert_eq!(bucket(0), "small");
    assert_eq!(bucket(SMALL_BELOW - 1), "small");
    assert_eq!(bucket(SMALL_BELOW), "medium");
    assert_eq!(bucket(LARGE_ABOVE), "medium");
    assert_eq!(bucket(LARGE_ABOVE + 1), "large");
}

#[test]
fn only_the_runbook_profile_is_sized_by_its_scout() {
    assert!(!counted("runbook"));
    for p in ["rust", "nix", "sql", "general"] {
        assert!(counted(p), "{p}");
    }
}

#[test]
fn numstat_is_read_per_new_path_a_rename_and_a_binary_file_included() {
    let z = "3\t2\tsrc/a.rs\x001\t0\t\x00old/b.rs\x00src/b.rs\x00-\t-\timg.png\x00";
    let got = parse(z);
    assert_eq!(got.get("src/a.rs"), Some(&5));
    assert_eq!(got.get("src/b.rs"), Some(&1), "{got:?}");
    assert_eq!(got.get("old/b.rs"), None);
    assert_eq!(got.get("img.png"), Some(&0));
    assert!(parse("").is_empty());
}

fn git(dir: &std::path::Path, args: &[&str]) {
    let ok = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .output()
        .unwrap();
    assert!(ok.status.success(), "git {args:?}");
}

fn diff_at(merge_base: &str) -> crate::git::Diff {
    serde_json::from_value(serde_json::json!({
        "base": "main", "mergeBase": merge_base, "head": "", "dirty": true,
        "files": [], "stat": "", "log": ""
    }))
    .unwrap()
}

#[test]
fn each_track_counts_the_lines_its_own_files_changed() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    git(d, &["init", "-q", "-b", "main"]);
    std::fs::write(d.join("README.md"), "x\n").unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "init"]);
    let base = String::from_utf8(
        Command::new("git")
            .arg("-C")
            .arg(d)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    std::fs::create_dir_all(d.join("src")).unwrap();
    std::fs::write(d.join("src/lib.rs"), "a\nb\nc\n").unwrap();
    std::fs::write(d.join("flake.nix"), "{ }\n").unwrap();
    std::fs::write(d.join("README.md"), "y\n").unwrap();
    let diff = diff_at(base.trim());
    git(d, &["add", "-N", "."]);
    let mut tracks = vec![
        Track::new("rust", vec!["src/lib.rs".into()]),
        Track::new("nix", vec!["flake.nix".into(), "README.md".into()]),
    ];
    assert_eq!(mark(d, &diff, &mut tracks), None);
    assert_eq!(tracks[0].changed_lines, Some(3));
    assert_eq!(
        tracks[1].changed_lines,
        Some(3),
        "one added, one removed and one added"
    );

    let gone = diff_at("no-such-commit");
    let note = mark(d, &gone, &mut tracks).unwrap();
    assert!(note.contains("could not be counted"), "{note}");
    assert!(tracks.iter().all(|t| t.changed_lines.is_none()));
}

#[test]
fn the_scout_must_name_the_size_only_where_the_binary_does_not_set_it() {
    assert_eq!(told("rust", Some(12)), Some(12));
    assert_eq!(told("runbook", Some(12)), None);
    assert_eq!(told("rust", None), None);
    let schema = || serde_json::json!({"required": ["lenses"]});
    assert_eq!(
        scout_schema(schema(), Some(12))["required"],
        serde_json::json!(["lenses"])
    );
    assert_eq!(
        scout_schema(schema(), None)["required"],
        serde_json::json!(["sizeBucket", "lenses"])
    );
    let held = serde_json::json!({"required": ["sizeBucket"]});
    assert_eq!(
        scout_schema(held, None)["required"],
        serde_json::json!(["sizeBucket"]),
        "never twice"
    );
}
