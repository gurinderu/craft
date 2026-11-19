use std::time::{Duration, Instant};

use super::Git;
use crate::cancel::{Cancel, STOPPED};

#[test]
fn a_stop_kills_the_running_git_and_starts_no_other() {
    let cancel = Cancel::default();
    let git = Git::prompt_free().stopped_by(cancel.clone());
    let stopper = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        cancel.cancel();
    });
    let began = Instant::now();
    let ran = git.run(&["-c", "alias.slow=!sleep 30", "slow"]);
    stopper.join().unwrap();
    assert!(
        began.elapsed() < Duration::from_secs(5),
        "{:?}",
        began.elapsed()
    );
    assert_eq!(ran, Err(STOPPED.to_owned()));
    assert_eq!(git.run(&["--version"]), Err(STOPPED.to_owned()));
}
