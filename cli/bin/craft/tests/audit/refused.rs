//! The arguments an audit refuses, each exiting as a refused argument does.

use std::process::Output;

use super::{craft, scratch};

fn refused(out: &Output, says: &str) {
    assert_eq!(
        out.status.code(),
        Some(2),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains(says), "{err}");
}

#[test]
fn a_bad_argument_exits_as_a_refused_one_and_a_missing_run_as_a_failure() {
    let s = scratch(&["tool.py"]);
    let (repo, run) = (s.repo.display().to_string(), s.run.display().to_string());
    let audit = |extra: &[&str]| {
        let mut args = vec![
            "audit",
            "start",
            "--cwd",
            repo.as_str(),
            "--run-dir",
            run.as_str(),
        ];
        args.extend_from_slice(extra);
        craft(&s, &args)
    };
    refused(&audit(&["--path", "../x"]), "is refused");
    refused(&audit(&["--path", "nowhere"]), "holds no file git tracks");
    refused(&audit(&["--batch-bytes", "0"]), "--batch-bytes");
    refused(&audit(&["--lens-agents", "0"]), "--lens-agents");
    let outside = tempfile::tempdir().unwrap();
    let elsewhere = outside.path().display().to_string();
    let out = craft(
        &s,
        &["audit", "start", "--cwd", &elsewhere, "--run-dir", &run],
    );
    refused(&out, "listing the tracked files");
    let gone = craft(&s, &["audit", "submit", "--run", &run]);
    assert_eq!(
        gone.status.code(),
        Some(1),
        "{}",
        String::from_utf8_lossy(&gone.stderr)
    );
}
