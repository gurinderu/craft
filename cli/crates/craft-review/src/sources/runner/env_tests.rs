//! The no-prompt environment as an ssh git starts sees it: a fake ssh (`GIT_SSH_COMMAND`) that
//! records its environment and fails. The caller's environment is set on the command, so the
//! test's own does not count.
#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use super::Git;

const VARS: [&str; 3] = ["SSH_ASKPASS_REQUIRE", "GIT_ASKPASS", "GIT_TERMINAL_PROMPT"];

/// What the fake ssh saw of [`VARS`], `None` for one it did not have, once git ran it against an
/// ssh remote with the caller's `set` (the rest of `VARS` unset).
fn seen_by_ssh(dir: &Path, set: &[(&str, &str)]) -> Vec<Option<String>> {
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
        .extend(set.iter().map(|(k, v)| ((*k).into(), (*v).into())));
    git.unset.extend(
        VARS.iter()
            .filter(|v| !set.iter().any(|(k, _)| k == *v))
            .map(Into::into),
    );
    let ran = git.run(&["ls-remote", "--", "ssh://git@example.invalid/org/sys.git"]);
    assert!(ran.is_err(), "{ran:?}");
    let env = std::fs::read_to_string(seen).expect("the fake ssh ran");
    VARS.iter()
        .map(|v| {
            env.lines()
                .find_map(|l| l.strip_prefix(&format!("{v}=")).map(str::to_owned))
        })
        .collect()
}

#[test]
fn with_no_choice_of_the_callers_ssh_never_asks_and_git_has_no_askpass_added() {
    let tmp = tempfile::tempdir().unwrap();
    assert_eq!(
        seen_by_ssh(tmp.path(), &[]),
        [Some("never".to_owned()), None, Some("0".to_owned())]
    );
}

#[test]
fn the_callers_own_choices_pass_through_and_the_terminal_prompt_is_still_off() {
    let tmp = tempfile::tempdir().unwrap();
    let seen = seen_by_ssh(
        tmp.path(),
        &[
            ("SSH_ASKPASS_REQUIRE", "prefer"),
            ("GIT_ASKPASS", "/ci/token"),
            ("GIT_TERMINAL_PROMPT", "1"),
        ],
    );
    assert_eq!(
        seen,
        [
            Some("prefer".to_owned()),
            Some("/ci/token".to_owned()),
            Some("0".to_owned())
        ]
    );
}
