use std::ffi::OsStr;
use std::process::Command;

use super::no_prompt_env;

/// The value `cmd` sets `var` to, `None` when it sets none.
fn env_of<'a>(cmd: &'a Command, var: &str) -> Option<&'a OsStr> {
    cmd.get_envs().find(|(k, _)| *k == var).and_then(|(_, v)| v)
}

#[test]
fn the_callers_ssh_askpass_rule_is_kept_and_the_terminal_prompt_is_off() {
    let mut cmd = Command::new("git");
    cmd.env("SSH_ASKPASS_REQUIRE", "force")
        .env("GIT_TERMINAL_PROMPT", "1");
    no_prompt_env(&mut cmd);
    assert_eq!(
        env_of(&cmd, "SSH_ASKPASS_REQUIRE"),
        Some(OsStr::new("force"))
    );
    assert_eq!(env_of(&cmd, "GIT_TERMINAL_PROMPT"), Some(OsStr::new("0")));
}

#[test]
fn with_no_rule_of_the_callers_ssh_never_asks_and_git_askpass_is_left_alone() {
    let mut cmd = Command::new("git");
    cmd.env_remove("SSH_ASKPASS_REQUIRE")
        .env_remove("GIT_ASKPASS");
    no_prompt_env(&mut cmd);
    assert_eq!(
        env_of(&cmd, "SSH_ASKPASS_REQUIRE"),
        Some(OsStr::new("never"))
    );
    assert_eq!(env_of(&cmd, "GIT_ASKPASS"), None);
}
