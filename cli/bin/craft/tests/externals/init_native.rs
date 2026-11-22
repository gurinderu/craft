use super::{run, value};
use serde_json::{Value, json};
use std::{os::unix::fs::symlink, path::Path, process::Command};

#[test]
fn origin_discards_output_when_a_successful_parent_leaves_stdout_open() {
    use std::os::unix::fs::PermissionsExt;
    use std::time::{Duration, Instant};

    let t = tempfile::tempdir().unwrap();
    let root = t.path();
    std::fs::create_dir(root.join("bin")).unwrap();
    let git = root.join("bin/git");
    std::fs::write(
        &git,
        "#!/bin/sh\ncase \"$3\" in\nrev-parse) printf '%s\\n' \"$2\" ;;\nremote) /bin/sleep 12 &\n  printf '%s' \"$!\" > \"$2/descendant\"\n  printf 'https://github.com/acme/db\\n' ;;\nesac\nexit 0\n",
    )
    .unwrap();
    std::fs::set_permissions(git, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(root.join("values.yaml"), "image: ghcr.io/acme/db:v1\n").unwrap();
    let began = Instant::now();
    let out = run(
        root,
        &[
            "init",
            "--propose",
            "--cwd",
            root.to_str().unwrap(),
            "--craft-root",
            "/missing-plugin",
        ],
        "",
    );
    let elapsed = began.elapsed();
    let pid = std::fs::read_to_string(root.join("descendant")).unwrap();
    if elapsed < Duration::from_secs(12) {
        drop(
            Command::new("/bin/sh")
                .args(["-c", "kill \"$1\"", "sh", &pid])
                .status(),
        );
    }
    let got = value(&out, 0);
    assert_eq!(got["discovery"]["candidates"][0]["system"], "db", "{got}");
    assert!(elapsed < Duration::from_secs(12), "{elapsed:?}");
}

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
