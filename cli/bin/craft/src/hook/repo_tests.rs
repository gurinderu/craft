use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

use super::fetch_command;
use crate::hook::bounded;

#[test]
fn the_base_fetch_runs_in_a_session_of_its_own_with_no_terminal_prompt() {
    let d = tempfile::tempdir().unwrap();
    let bin = d.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let seen = d.path().join("seen");
    let args = d.path().join("args");
    // A git that says its pid, its session and its terminal prompt.
    std::fs::write(
        bin.join("git"),
        format!(
            "#!/bin/sh\necho \"$$ $(ps -o sid= -p $$ | tr -d ' ') $GIT_TERMINAL_PROMPT\" > '{}'\n\
             echo \"$*\" > '{}'\n",
            seen.display(),
            args.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(bin.join("git"), std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut cmd = fetch_command(d.path(), "main");
    let path = std::env::var("PATH").unwrap_or_default();
    cmd.env("PATH", format!("{}:{path}", bin.display()));
    let out = bounded::output(cmd, Duration::from_secs(10)).unwrap();
    assert!(out.status.success(), "{out:?}");
    let seen = std::fs::read_to_string(&seen).unwrap();
    let words: Vec<&str> = seen.split_whitespace().collect();
    assert_eq!(words.len(), 3, "{seen}");
    assert_eq!(words[0], words[1], "not a session of its own: {seen}");
    assert_eq!(words[2], "0", "{seen}");
    // No maintenance git would start in the background, for the limit to kill with the group.
    let args = std::fs::read_to_string(&args).unwrap();
    assert!(
        args.contains("-c maintenance.auto=false -c gc.auto=0 "),
        "{args}"
    );
}
