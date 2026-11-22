//! `craft init --propose --path`: named manifests read in place of the walk.
use super::{run, value};
use serde_json::{Value, json};
use std::{os::unix::fs::symlink, path::Path, path::PathBuf, process::Command};

/// A git repository under `root` with only `git` on PATH.
fn repo(root: &Path) -> PathBuf {
    std::fs::create_dir(root.join("bin")).unwrap();
    let git = std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|p| p.join("git"))
        .find(|p| p.is_file())
        .unwrap()
        .canonicalize()
        .unwrap();
    symlink(&git, root.join("bin/git")).unwrap();
    let repo = root.join("repo");
    std::fs::create_dir(&repo).unwrap();
    assert!(
        Command::new(git)
            .args(["init", "-q"])
            .arg(&repo)
            .status()
            .unwrap()
            .success()
    );
    repo
}

fn put(repo: &Path, file: &str, text: &str) {
    let path = repo.join(file);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn propose(root: &Path, repo: &Path, paths: &[&str]) -> std::process::Output {
    let mut args = vec!["init", "--propose", "--cwd", repo.to_str().unwrap()];
    for p in paths {
        args.extend(["--path", p]);
    }
    run(root, &args, "")
}

fn systems(got: &Value) -> Vec<&str> {
    got.pointer("/discovery/candidates")
        .and_then(Value::as_array)
        .unwrap()
        .iter()
        .map(|c| c["system"].as_str().unwrap())
        .collect()
}

#[test]
fn named_manifests_are_read_in_the_order_given_with_a_missing_one_unread() {
    let t = tempfile::tempdir().unwrap();
    let repo = repo(t.path());
    put(&repo, "a/values.yaml", "image: x/ay:v1\n");
    put(&repo, "b/values.yaml", "image: x/bee:v1\n");
    put(&repo, "c/values.yaml", "image: x/sea:v1\n");
    let inside = repo.join("a/values.yaml");
    let got = value(
        &propose(
            t.path(),
            &repo,
            &[
                "b/values.yaml",
                inside.to_str().unwrap(),
                "missing.yaml",
                "b/values.yaml",
            ],
        ),
        0,
    );
    assert_eq!(systems(&got), ["bee", "ay", "bee"], "{got}");
    assert_eq!(
        got["discovery"]["unread"],
        json!([{"file": "missing.yaml", "error": "manifest missing.yaml not found"}])
    );
    assert!(got["discovery"].get("walkCut").is_none());
}

#[test]
fn a_path_outside_the_repository_is_refused() {
    let t = tempfile::tempdir().unwrap();
    let repo = repo(t.path());
    put(t.path(), "outside.yaml", "image: x/out:v1\n");
    let outside = t.path().join("outside.yaml");
    for p in [
        "../outside.yaml",
        outside.to_str().unwrap(),
        "a/../../outside.yaml",
        "",
    ] {
        let out = propose(t.path(), &repo, &[p]);
        assert_eq!(out.status.code(), Some(1), "{p}");
        assert!(out.stdout.is_empty(), "{p}");
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(
            stderr.contains("not a file inside the repository"),
            "{p}: {stderr}"
        );
    }
}

#[test]
fn past_the_walk_bound_the_cut_names_the_flag_that_reads_the_rest() {
    let t = tempfile::tempdir().unwrap();
    let repo = repo(t.path());
    // `.skip` sorts before `a`: the walk's 100000 entries end before `a/values.yaml`.
    for i in 0..100_000 {
        std::fs::write(repo.join(format!(".skip{i:06}")), "").unwrap();
    }
    put(&repo, "a/values.yaml", "image: x/ay:v1\n");
    let got = value(&propose(t.path(), &repo, &[]), 0);
    assert!(systems(&got).is_empty(), "{got}");
    let cut = got["discovery"]["walkCut"].as_str().unwrap();
    assert!(cut.contains("craft init --propose --path <file>"), "{cut}");
    let got = value(&propose(t.path(), &repo, &["a/values.yaml"]), 0);
    assert_eq!(systems(&got), ["ay"], "{got}");
}
