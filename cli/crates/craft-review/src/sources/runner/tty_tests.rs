//! The caller's own `GIT_SSH_COMMAND` asking a passphrase on the terminal: the preparation run
//! under a terminal of its own (`script` gives the test one), the ssh a script that reads
//! `/dev/tty`. Linux only: `script`'s flags are util-linux's.
#![cfg(target_os = "linux")]

use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::Git;
use crate::project::IntegrationPoint;
use crate::sources::{prepare, section};

/// Set in the run `script` starts: this test is then the one under the terminal.
const UNDER_TTY: &str = "CRAFT_TEST_UNDER_TTY";
const NAME: &str =
    "sources::runner::tty_tests::a_passphrase_asked_on_the_terminal_fails_at_once_and_is_named";
/// An ssh that asks on the terminal when there is one, and fails at once when there is none.
const ASKING_SSH: &str = "#!/bin/sh
if ( : </dev/tty ) 2>/dev/null; then
  printf 'Enter passphrase: ' >/dev/tty
  read -r pass </dev/tty
  echo 'ssh: the passphrase was read' >&2
else
  echo 'ssh: no terminal to ask the passphrase on' >&2
fi
exit 255
";

#[test]
fn a_passphrase_asked_on_the_terminal_fails_at_once_and_is_named() {
    if std::env::var_os(UNDER_TTY).is_some() {
        under_tty();
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let ssh = tmp.path().join("ssh");
    std::fs::write(&ssh, ASKING_SSH).unwrap();
    std::fs::set_permissions(&ssh, std::fs::Permissions::from_mode(0o755)).unwrap();
    let exe = std::env::current_exe().unwrap();
    let inner = format!(
        "'{}' '{NAME}' --exact --nocapture --test-threads=1",
        exe.display()
    );
    let mut run = Command::new("script")
        .args(["-qec", &inner, "/dev/null"])
        .env(UNDER_TTY, "1")
        .env("GIT_SSH_COMMAND", &ssh)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("util-linux script, to give the run a terminal");
    let deadline = Instant::now() + Duration::from_secs(60);
    while run.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
            run.kill().unwrap_or(());
            run.wait().unwrap();
            panic!("the run under a terminal hung past 60s");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let mut out = String::new();
    run.stdout.take().unwrap().read_to_string(&mut out).unwrap();
    let status = run.wait().unwrap();
    assert!(
        status.success() && out.contains("1 passed"),
        "{status}\n{out}"
    );
}

/// The preparation of a source behind the asking ssh, with a terminal to ask on.
fn under_tty() {
    assert!(
        std::fs::File::open("/dev/tty").is_ok(),
        "no terminal: the case is not exercised"
    );
    let point = IntegrationPoint {
        name: "sys".into(),
        repo: "ssh://git@example.invalid/org/sys.git".into(),
        rev: "v1.2.3".into(),
    };
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
    assert!(got.failed[0].error.starts_with("git failed: "), "{got:?}");
    assert!(section(&got, &[]).contains("- ⚠️ sys: git failed: "));
}
