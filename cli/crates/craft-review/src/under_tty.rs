//! A test run again under a terminal of its own (`script` gives it one), for what craft starts
//! that might ask on `/dev/tty`. Linux only: `script`'s flags are util-linux's.
#![cfg(target_os = "linux")]

use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// Set in the run `script` starts, to the file it leaves its process group in: the test is then
/// the one under the terminal.
const UNDER_TTY: &str = "CRAFT_TEST_UNDER_TTY";
/// A program that asks on the terminal when there is one, and fails at once when there is none.
/// It leaves `<itself>.ran` behind, so a test knows it was what ran.
const ASKING: &str = "#!/bin/sh
: > \"$0.ran\"
if ( : </dev/tty ) 2>/dev/null; then
  printf 'Enter passphrase: ' >/dev/tty
  read -r pass </dev/tty
  echo 'the passphrase was read' >&2
else
  echo 'no terminal to ask the passphrase on' >&2
fi
exit 255
";

/// Whether this run is the one under the terminal; it checks there is one to ask on, and leaves
/// its process group where the outer run can kill it.
pub(crate) fn is_under() -> bool {
    let Some(group_file) = std::env::var_os(UNDER_TTY) else {
        return false;
    };
    let group = nix::unistd::getpgrp().as_raw();
    std::fs::write(group_file, group.to_string()).unwrap();
    assert!(
        std::fs::File::open("/dev/tty").is_ok(),
        "no terminal: the case is not exercised"
    );
    true
}

/// The asking program, written into `dir` and executable.
pub(crate) fn asking(dir: &Path) -> PathBuf {
    let at = dir.join("asking");
    std::fs::write(&at, ASKING).unwrap();
    std::fs::set_permissions(&at, std::fs::Permissions::from_mode(0o755)).unwrap();
    at
}

/// Whether the asking program at `program` ran.
pub(crate) fn asked(program: &Path) -> bool {
    program.with_extension("ran").is_file()
}

/// Whether a terminal can be had here: `/dev/ptmx` and a `script` that runs. Without one the
/// test is skipped, said on stderr — except under CI (`CI` set), where it fails: there the case
/// must be exercised.
fn terminal_to_be_had(name: &str) -> bool {
    let script = Command::new("script")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success());
    let had = script && Path::new("/dev/ptmx").exists();
    assert!(
        had || std::env::var_os("CI").is_none(),
        "{name}: no util-linux script or /dev/ptmx under CI, the terminal case unexercised"
    );
    if !had {
        let _noted = writeln!(
            std::io::stderr(),
            "{name}: skipped, no util-linux script or /dev/ptmx to give it a terminal"
        );
    }
    had
}

/// `text` as one word of a POSIX shell.
fn quoted(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

/// A thread that reads `pipe` to its end.
fn drain(mut pipe: impl Read + Send + 'static) -> JoinHandle<String> {
    std::thread::spawn(move || {
        let mut text = String::new();
        let _read = pipe.read_to_string(&mut text);
        text
    })
}

/// Runs the test `name` (its full path) again under a terminal with `env` added, and checks it
/// passed — within 60 s, so a hang fails rather than waits, the inner run killed with `script`;
/// skipped where no terminal can be had ([`terminal_to_be_had`]).
pub(crate) fn rerun(name: &str, env: &[(&str, &Path)]) {
    if !terminal_to_be_had(name) {
        return;
    }
    let exe = std::env::current_exe().unwrap();
    let inner = format!(
        "{} {} --exact --nocapture --test-threads=1",
        quoted(&exe.to_string_lossy()),
        quoted(name)
    );
    let tmp = tempfile::tempdir().unwrap();
    let group_file = tmp.path().join("group");
    let mut run = Command::new("script")
        .args(["-qec", &inner, "/dev/null"])
        .env(UNDER_TTY, &group_file)
        .envs(env.iter().copied())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("util-linux script, to give the run a terminal");
    let out = drain(run.stdout.take().unwrap());
    let err = drain(run.stderr.take().unwrap());
    let deadline = Instant::now() + Duration::from_secs(60);
    while run.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
            // The inner run is in a session of script's making: killed by its own group.
            if let Some(group) = std::fs::read_to_string(&group_file)
                .ok()
                .and_then(|g| g.trim().parse().ok())
            {
                let group = nix::unistd::Pid::from_raw(group);
                nix::sys::signal::killpg(group, nix::sys::signal::Signal::SIGKILL).unwrap_or(());
            }
            run.kill().unwrap_or(());
            run.wait().unwrap();
            panic!("the run under a terminal hung past 60s");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let status = run.wait().unwrap();
    let (out, err) = (out.join().unwrap(), err.join().unwrap());
    assert!(
        status.success() && out.contains("1 passed"),
        "{status}\n{out}\n{err}"
    );
}
