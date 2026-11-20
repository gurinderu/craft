//! A gate tool asking on the terminal (cargo fetching a git dependency over ssh, a credential
//! helper): the tool run under a terminal of its own, a program that reads `/dev/tty`.
#![cfg(target_os = "linux")]

use std::time::{Duration, Instant};

use super::{Ran, Runner};
use crate::under_tty;

#[test]
fn a_tool_asking_on_the_terminal_fails_at_once() {
    if !under_tty::is_under() {
        under_tty::rerun(
            "gate::runner::tty_tests::a_tool_asking_on_the_terminal_fails_at_once",
            &[],
        );
        return;
    }
    let d = tempfile::tempdir().unwrap();
    let bin = d.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    under_tty::asking(&bin);
    // Under the 60 s the outer run waits: a hang fails here, named, rather than there.
    let path = Some(bin.into_os_string());
    let r = Runner::new(Duration::from_secs(15), path, d.path().join("out"));
    let began = Instant::now();
    let ran = r.run(d.path(), "asking", &[]);
    assert!(
        began.elapsed() < Duration::from_secs(10),
        "{:?}: {ran:?}",
        began.elapsed()
    );
    let Ran::Exited { ok: false, err, .. } = ran else {
        panic!("{ran:?}");
    };
    assert!(
        err.contains("no terminal to ask the passphrase on"),
        "{err}"
    );
}
