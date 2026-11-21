use super::{run, value};
use serde_json::{Value, json};
use std::{os::unix::fs::symlink, path::Path, process::Command};

#[test]
fn init_proposal_and_write_need_only_git_and_no_plugin_checkout() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path();
    std::fs::create_dir(root.join("bin")).unwrap();
    let git = std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|p| p.join("git"))
        .find(|p| p.is_file())
        .unwrap()
        .canonicalize()
        .unwrap();
    symlink(git, root.join("bin/git")).unwrap();
    let repo = root.join("repo");
    std::fs::create_dir(&repo).unwrap();
    assert!(
        Command::new(root.join("bin/git"))
            .arg("init")
            .arg("-q")
            .arg(&repo)
            .status()
            .unwrap()
            .success()
    );
    std::fs::write(repo.join("values.yaml"), "image: ghcr.io/acme/db:v1\n").unwrap();
    let args = [
        "init",
        "--propose",
        "--cwd",
        repo.to_str().unwrap(),
        "--craft-root",
        "/missing-plugin",
        "--memory-externals",
        "-",
    ];
    let got = value(
        &run(
            root,
            &args,
            r#"[{"system":"old","repo":"r","version":"v2"}]"#,
        ),
        0,
    );
    assert_eq!(got["discovery"]["ran"], true);
    assert_eq!(got["memory"]["candidates"][0]["point"], "old=r@v2");
    assert!(got["memory"]["candidates"][0]["refused"].is_string());
    assert!(!Path::new(got["profile"].as_str().unwrap()).exists());
    assert_eq!(got["memory"]["candidates"][0]["profileRef"], Value::Null);
    let bad = value(&run(root, &args, "not json"), 0);
    assert_eq!(bad["memory"]["ran"], false);
    assert_eq!(bad["discovery"]["ran"], true);
    let write = [
        "init",
        "--write",
        "--cwd",
        repo.to_str().unwrap(),
        "--point",
        "db=https://github.com/acme/db@v1",
    ];
    value(&run(root, &write, ""), 0);
    let got = value(
        &run(
            root,
            &args,
            r#"[{"system":"db","repo":"https://github.com/acme/db","version":"v2"}]"#,
        ),
        0,
    );
    assert_eq!(got["memory"]["candidates"][0]["profileRef"], "v1");
    assert_eq!(got["discovery"]["candidates"], json!([]));
}
