//! The caller's own ssh is kept: `GIT_SSH_COMMAND`, `GIT_SSH` or `core.sshCommand` set, craft
//! adds no batch-mode command of its own, which git would take over theirs.
#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;

use super::{Git, callers_ssh};

#[test]
fn a_callers_git_ssh_or_git_ssh_command_is_kept() {
    let tmp = tempfile::tempdir().unwrap();
    for var in ["GIT_SSH", "GIT_SSH_COMMAND"] {
        assert!(callers_ssh(tmp.path(), |v| v == var), "{var}");
    }
    assert!(!callers_ssh(tmp.path(), |_| false));
}

/// `core.sshCommand` set in `dir`'s configuration to a fake ssh that leaves `ran` and fails.
fn configured(dir: &Path) -> std::path::PathBuf {
    let ssh = dir.join("ssh");
    let ran = dir.join("ran");
    std::fs::write(
        &ssh,
        format!("#!/bin/sh\ntouch '{}'\nexit 255\n", ran.display()),
    )
    .unwrap();
    std::fs::set_permissions(&ssh, std::fs::Permissions::from_mode(0o755)).unwrap();
    let git = |args: &[&str]| {
        let ok = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .status()
            .unwrap();
        assert!(ok.success(), "{args:?}");
    };
    git(&["init", "-q"]);
    git(&["config", "core.sshCommand", &ssh.display().to_string()]);
    ran
}

#[test]
fn a_configured_core_ssh_command_is_the_ssh_git_runs() {
    let tmp = tempfile::tempdir().unwrap();
    let ran = configured(tmp.path());
    let mut git = Git::prompt_free_in(tmp.path());
    // The test's own environment does not count.
    git.unset
        .extend(["GIT_SSH_COMMAND".into(), "GIT_SSH".into()]);
    assert!(
        !git.env.iter().any(|(k, _)| k == "GIT_SSH_COMMAND"),
        "{:?}",
        git.env
    );
    let at = tmp.path().display().to_string();
    let url = "ssh://git@example.invalid/org/sys.git";
    let got = git.run_remote(&["-C", &at, "ls-remote", "--", url]);
    assert!(got.is_err(), "{got:?}");
    assert!(ran.exists(), "the configured ssh never ran: {got:?}");
}
