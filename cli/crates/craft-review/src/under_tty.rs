//! A test run again under a terminal of its own (`script` gives it one), for what craft starts
//! that might ask on `/dev/tty`. Linux only: `script`'s flags are util-linux's.
#![cfg(target_os = "linux")]

use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Set in the run `script` starts: the test is then the one under the terminal.
const UNDER_TTY: &str = "CRAFT_TEST_UNDER_TTY";
/// A program that asks on the terminal when there is one, and fails at once when there is none.
const ASKING: &str = "#!/bin/sh
if ( : </dev/tty ) 2>/dev/null; then
  printf 'Enter passphrase: ' >/dev/tty
  read -r pass </dev/tty
  echo 'the passphrase was read' >&2
else
  echo 'no terminal to ask the passphrase on' >&2
fi
exit 255
";

/// Whether this run is the one under the terminal; it checks there is one to ask on.
pub(crate) fn is_under() -> bool {
    let under = std::env::var_os(UNDER_TTY).is_some();
    if under {
        assert!(
            std::fs::File::open("/dev/tty").is_ok(),
            "no terminal: the case is not exercised"
        );
    }
    under
}

/// The asking program, written into `dir` and executable.
pub(crate) fn asking(dir: &Path) -> PathBuf {
    let at = dir.join("asking");
    std::fs::write(&at, ASKING).unwrap();
    std::fs::set_permissions(&at, std::fs::Permissions::from_mode(0o755)).unwrap();
    at
}

/// Runs the test `name` (its full path) again under a terminal with `env` added, and checks it
/// passed — within 60 s, so a hang fails rather than waits.
pub(crate) fn rerun(name: &str, env: &[(&str, &Path)]) {
    let exe = std::env::current_exe().unwrap();
    let inner = format!(
        "'{}' '{name}' --exact --nocapture --test-threads=1",
        exe.display()
    );
    let mut run = Command::new("script")
        .args(["-qec", &inner, "/dev/null"])
        .env(UNDER_TTY, "1")
        .envs(env.iter().copied())
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
