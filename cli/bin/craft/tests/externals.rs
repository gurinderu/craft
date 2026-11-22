//! Native compatibility and init composition. The command runs with no Node on PATH.
#![expect(
    clippy::unwrap_used,
    reason = "fixture setup and JSON assertions fail loudly"
)]
use serde_json::{Value, json};
use std::io::Write;
use std::path::Path;
use std::process::{Command, Output, Stdio};

fn run(root: &Path, args: &[&str], input: &str) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_craft"))
        .args(args)
        .env("HOME", root.join("home"))
        .env("PATH", root.join("bin"))
        .env_remove("CRAFT_ROOT")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", root.join("no-gitconfig"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}

fn value(out: &Output, code: i32) -> Value {
    assert_eq!(
        out.status.code(),
        Some(code),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        out.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}

#[test]
fn raw_compatibility_errors_are_exit_one_json_even_help_and_double_dash() {
    let t = tempfile::tempdir().unwrap();
    for args in [
        vec!["__craft-externals"],
        vec!["__craft-externals", "--help"],
        vec!["__craft-externals", "--version"],
        vec!["__craft-externals", "--", "discover"],
        vec!["__craft-externals", "discover", "--repo-root"],
        vec!["__craft-externals", "memory", "--repo-root", "relative"],
    ] {
        let got = value(&run(t.path(), &args, ""), 1);
        assert!(got["error"].is_string(), "{args:?}: {got}");
    }
}

#[test]
fn compatibility_has_original_envelope_and_handles_non_git_roots_without_node() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().to_str().unwrap();
    std::fs::write(t.path().join("values.yaml"), "image: ghcr.io/acme/db:v1\n").unwrap();
    let args = [
        "__craft-externals",
        "discover",
        "--repo-root",
        root,
        "--paths",
        "WyJ2YWx1ZXMueWFtbCIsIm1pc3NpbmciXQ",
    ];
    let got = value(&run(t.path(), &args, ""), 0);
    assert_eq!(got["candidates"][0]["system"], "db");
    assert_eq!(
        got["unread"],
        json!([{"file":"missing","error":"manifest missing not found"}])
    );
    assert!(got.get("ran").is_none());
    let args = ["__craft-externals", "memory", "--repo-root", root];
    let got = value(
        &run(
            t.path(),
            &args,
            r#"[{"system":"db","repo":"r","versionFrom":"values.yaml","versionMatch":"(?<=:)(v1)$"}]"#,
        ),
        0,
    );
    assert_eq!(got["candidates"][0]["ref"], "v1");
    assert!(got["candidates"][0].get("point").is_none());
    let got = value(&run(t.path(), &args, "{}"), 1);
    assert_eq!(
        got,
        json!({"error":"stdin is not JSON of a list of records"})
    );
    let out = run(t.path(), &["init", "--propose", "--cwd", root], "");
    assert_eq!(out.status.code(), Some(1));
}

#[test]
fn compatibility_preserves_json_lone_surrogates() {
    let t = tempfile::tempdir().unwrap();
    let args = [
        "__craft-externals",
        "memory",
        "--repo-root",
        t.path().to_str().unwrap(),
    ];
    let out = run(
        t.path(),
        &args,
        r#"[{"system":"s","repo":"\ud800","version":"v1","scope":"\udfff"}]"#,
    );
    assert!(out.status.success());
    let got = craft_store::js::parse(std::str::from_utf8(&out.stdout).unwrap()).unwrap();
    assert_eq!(
        got.compact(),
        r#"{"candidates":[{"system":"s","repo":"\ud800","ref":"v1","scope":"\udfff","version":"v1"}],"refused":[]}"#
    );
}

#[cfg(unix)]
#[path = "externals/init_native.rs"]
mod init_native;
