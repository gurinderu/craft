//! The caller's own `GIT_SSH_COMMAND` asking a passphrase on the terminal: the preparation run
//! under a terminal of its own, the ssh a program that reads `/dev/tty`.
#![cfg(target_os = "linux")]

use std::path::Path;
use std::time::{Duration, Instant};

use super::Git;
use crate::project::IntegrationPoint;
use crate::sources::{prepare, section};
use crate::under_tty;

#[test]
fn a_passphrase_asked_on_the_terminal_fails_at_once_and_is_named() {
    if !under_tty::is_under() {
        let tmp = tempfile::tempdir().unwrap();
        let ssh = under_tty::asking(tmp.path());
        under_tty::rerun(
            "sources::runner::tty_tests::a_passphrase_asked_on_the_terminal_fails_at_once_and_is_named",
            &[("GIT_SSH_COMMAND", &ssh)],
        );
        return;
    }
    let point = IntegrationPoint {
        name: "sys".into(),
        repo: "ssh://git@example.invalid/org/sys.git".into(),
        rev: "v1.2.3".into(),
    };
    let ssh = std::env::var_os("GIT_SSH_COMMAND").unwrap();
    let cache = tempfile::tempdir().unwrap();
    let mut git = Git::prompt_free();
    // Under the 60 s the outer run waits: a hang fails here, named, rather than there.
    git.timeout = Duration::from_secs(15);
    let began = Instant::now();
    let got = prepare(&[point], Ok(cache.path()), &git);
    assert!(
        began.elapsed() < Duration::from_secs(10),
        "{:?}: {got:?}",
        began.elapsed()
    );
    assert!(
        under_tty::asked(Path::new(&ssh)),
        "the asking ssh never ran"
    );
    let error = &got.failed[0].error;
    assert!(error.starts_with("git failed: "), "{got:?}");
    assert!(error.contains("ssh-agent"), "{error}");
    assert!(section(&got, &[]).contains("- ⚠️ sys: git failed: "));
}
