use std::path::Path;
use std::process::Command;

use super::{PROFILES, Scouted, profiles, scout, tracked};
use crate::batch::Tracked;

fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        ok.status.success(),
        "{}",
        String::from_utf8_lossy(&ok.stderr)
    );
}

fn repo(files: &[(&str, &str)]) -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    git(d.path(), &["init", "-q"]);
    for (path, text) in files {
        let at = d.path().join(path);
        std::fs::create_dir_all(at.parent().unwrap()).unwrap();
        std::fs::write(at, text).unwrap();
    }
    git(d.path(), &["add", "-A"]);
    d
}

fn paths(t: &[Tracked]) -> Vec<&str> {
    t.iter().map(|f| f.path.as_str()).collect()
}

#[test]
fn only_tracked_regular_files_are_listed_with_their_sizes_and_a_path_narrows_them() {
    let d = repo(&[
        ("src/lib.rs", "fn a() {}\n"),
        ("app.py", "x = 1\n"),
        ("gone.rs", ""),
    ]);
    std::fs::write(d.path().join("untracked.rs"), "fn b() {}").unwrap();
    std::fs::remove_file(d.path().join("gone.rs")).unwrap();
    let all = tracked(d.path(), &[]).unwrap();
    assert_eq!(paths(&all), ["app.py", "src/lib.rs"]);
    assert_eq!(all[1].bytes, 10);
    let under = tracked(d.path(), &["src".into()]).unwrap();
    assert_eq!(paths(&under), ["src/lib.rs"]);
}

#[test]
fn a_path_is_taken_literally_never_as_a_glob() {
    let d = repo(&[("a.rs", ""), ("b.rs", "")]);
    assert!(tracked(d.path(), &["*.rs".into()]).unwrap().is_empty());
}

#[cfg(unix)]
#[test]
fn a_tracked_symlink_is_not_read() {
    let d = repo(&[("real.rs", "fn a() {}")]);
    std::os::unix::fs::symlink("real.rs", d.path().join("link.rs")).unwrap();
    git(d.path(), &["add", "-A"]);
    assert_eq!(paths(&tracked(d.path(), &[]).unwrap()), ["real.rs"]);
}

#[test]
fn a_directory_git_does_not_track_is_refused_as_not_git() {
    let d = tempfile::tempdir().unwrap();
    let got = tracked(d.path(), &[]);
    assert!(
        matches!(&got, Err(crate::AuditError::NotGit { .. })),
        "{got:?}"
    );
}

fn file(path: &str, bytes: u64) -> Tracked {
    Tracked {
        path: path.into(),
        bytes,
    }
}

#[test]
fn each_file_goes_to_the_profile_the_review_gives_it_and_the_rest_is_outside() {
    let all = profiles().unwrap();
    let ids: Vec<&str> = all.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(ids, PROFILES);
    let files = [
        file("src/lib.rs", 5),
        file("flake.nix", 5),
        file("db/0001.sql", 5),
        file("web/app.ts", 5),
        file("README.md", 5),
        file("RUNBOOK.md", 5),
        file("Dockerfile", 5),
    ];
    let got = scout(&files, &all, 100);
    let parts: Vec<(&str, Vec<String>)> = got
        .parts
        .iter()
        .map(|p| {
            (
                p.profile.as_str(),
                p.batches
                    .iter()
                    .flat_map(crate::batch::Batch::paths)
                    .collect(),
            )
        })
        .collect();
    assert_eq!(
        parts,
        [
            ("rust", vec!["src/lib.rs".to_owned()]),
            ("nix", vec!["flake.nix".to_owned()]),
            ("sql", vec!["db/0001.sql".to_owned()]),
            ("general", vec!["web/app.ts".to_owned()]),
        ]
    );
    assert_eq!(got.outside, ["README.md", "RUNBOOK.md", "Dockerfile"]);
    assert_eq!((got.tracked, got.audited()), (7, 4));
}

#[test]
fn a_part_is_cut_by_the_budget_with_each_file_keeping_its_size() {
    let all = profiles().unwrap();
    let files = [file("a.rs", 6), file("b.rs", 6), file("c.rs", 1)];
    let got: Scouted = scout(&files, &all, 10);
    let rust = &got.parts[0];
    assert_eq!(rust.batches.len(), 2);
    assert_eq!(rust.batches[1].paths(), ["b.rs", "c.rs"]);
    assert_eq!(rust.batches[1].bytes(), 7);
}
