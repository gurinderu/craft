//! The no-prompt environment as an ssh git starts sees it: a fake ssh (`GIT_SSH_COMMAND`) that
//! records its environment and fails.
#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use super::Git;
use crate::cancel::caller_chooses_prompts;

/// The environment the fake ssh saw, one `NAME=value` a line, once git ran it against an ssh
/// remote with `env` added.
fn seen_by_ssh(dir: &Path, env: &[(&str, &str)]) -> Vec<String> {
    let ssh = dir.join("ssh");
    let seen = dir.join("env");
    std::fs::write(
        &ssh,
        format!("#!/bin/sh\nenv > '{}'\nexit 255\n", seen.display()),
    )
    .unwrap();
    std::fs::set_permissions(&ssh, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut git = Git::prompt_free();
    git.env
        .push(("GIT_SSH_COMMAND".into(), ssh.into_os_string()));
    git.env
        .extend(env.iter().map(|(k, v)| ((*k).into(), (*v).into())));
    let ran = git.run(&["ls-remote", "--", "ssh://git@example.invalid/org/sys.git"]);
    assert!(ran.is_err(), "{ran:?}");
    std::fs::read_to_string(seen)
        .expect("the fake ssh ran")
        .lines()
        .map(str::to_owned)
        .collect()
}

#[test]
fn with_no_choice_of_the_callers_ssh_never_asks_and_git_has_no_askpass() {
    if caller_chooses_prompts("with_no_choice_of_the_callers_ssh_never_asks_and_git_has_no_askpass")
    {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let env = seen_by_ssh(tmp.path(), &[]);
    for line in [
        "SSH_ASKPASS_REQUIRE=never",
        "GIT_ASKPASS=",
        "GIT_TERMINAL_PROMPT=0",
    ] {
        assert!(env.iter().any(|l| l == line), "{line} not in {env:?}");
    }
}

#[test]
fn the_callers_own_choices_are_kept_and_the_terminal_prompt_is_still_off() {
    let tmp = tempfile::tempdir().unwrap();
    let env = seen_by_ssh(
        tmp.path(),
        &[
            ("SSH_ASKPASS_REQUIRE", "prefer"),
            ("GIT_ASKPASS", "/ci/token"),
            ("GIT_TERMINAL_PROMPT", "1"),
        ],
    );
    for line in [
        "SSH_ASKPASS_REQUIRE=prefer",
        "GIT_ASKPASS=/ci/token",
        "GIT_TERMINAL_PROMPT=0",
    ] {
        assert!(env.iter().any(|l| l == line), "{line} not in {env:?}");
    }
}
