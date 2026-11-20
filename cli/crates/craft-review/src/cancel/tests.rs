use std::ffi::OsStr;
use std::process::Command;

use super::no_prompt;

/// The value `cmd` sets `var` to, `None` when it sets none.
fn env_of<'a>(cmd: &'a Command, var: &str) -> Option<&'a OsStr> {
    cmd.get_envs().find(|(k, _)| *k == var).and_then(|(_, v)| v)
}

#[test]
fn the_callers_askpass_choices_are_kept_on_the_command_and_the_terminal_prompt_is_off() {
    let mut cmd = Command::new("git");
    cmd.env("GIT_ASKPASS", "/ci/token")
        .env("SSH_ASKPASS_REQUIRE", "force")
        .env("GIT_TERMINAL_PROMPT", "1");
    no_prompt(&mut cmd);
    assert_eq!(env_of(&cmd, "GIT_ASKPASS"), Some(OsStr::new("/ci/token")));
    assert_eq!(
        env_of(&cmd, "SSH_ASKPASS_REQUIRE"),
        Some(OsStr::new("force"))
    );
    assert_eq!(env_of(&cmd, "GIT_TERMINAL_PROMPT"), Some(OsStr::new("0")));
}

#[test]
fn with_no_choice_git_has_no_askpass_and_ssh_never_asks() {
    if super::caller_chooses_prompts("with_no_choice_git_has_no_askpass_and_ssh_never_asks") {
        return;
    }
    let mut cmd = Command::new("git");
    no_prompt(&mut cmd);
    assert_eq!(env_of(&cmd, "GIT_ASKPASS"), Some(OsStr::new("")));
    assert_eq!(
        env_of(&cmd, "SSH_ASKPASS_REQUIRE"),
        Some(OsStr::new("never"))
    );
}
