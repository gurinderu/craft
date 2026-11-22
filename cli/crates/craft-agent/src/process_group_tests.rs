use std::io::{self, Read as _};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use nix::unistd::Pid;

use nix::sys::signal::killpg;

use super::{GroupGuard, settle_stops, stops_pending, unix};

/// The stop list is the process's own: the tests that stop a group take turns, so one test's
/// grace is not another's pending stop.
static TURN: Mutex<()> = Mutex::new(());

/// Takes this test's turn, with nothing left listed by the test before it.
fn turn() -> MutexGuard<'static, ()> {
    let turn = TURN.lock().unwrap_or_else(PoisonError::into_inner);
    settle_stops();
    turn
}

/// Whether the group `pgid` leads still has a member.
fn alive(pgid: Pid) -> bool {
    killpg(pgid, None).is_ok()
}

/// A group of its own that ignores SIGTERM, returned once its trap is set: stopped before that,
/// SIGTERM could end it before it ignores it.
fn deaf_group() -> Child {
    let mut child = Command::new("sh")
        .args(["-c", "trap '' TERM; echo ready; exec sleep 10"])
        .process_group(0)
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut ready = [0; 6];
    child.stdout.take().unwrap().read_exact(&mut ready).unwrap();
    child
}

fn pid(child: &Child) -> Pid {
    Pid::from_raw(i32::try_from(child.id()).unwrap())
}

/// A stopped group is pending while inside its grace, so the exit path that checks first still
/// waits it out.
#[test]
fn a_stopped_group_inside_its_grace_is_pending() {
    let _turn = turn();
    let mut child = deaf_group();
    drop(GroupGuard::new(Some(child.id())));
    assert!(stops_pending());
    settle_stops();
    // The grace ended in SIGKILL and reaped the killed leader: the group is gone.
    assert!(!alive(pid(&child)));
    let _reaped = child.wait();
}

/// A stop whose grace is over is no longer pending although nothing joined its thread.
#[test]
fn a_stop_whose_grace_ended_is_no_longer_pending_unsettled() {
    let _turn = turn();
    let mut child = Command::new("sleep")
        .arg("10")
        .process_group(0)
        .spawn()
        .unwrap();
    drop(GroupGuard::new(Some(child.id())));
    let deadline = Instant::now() + Duration::from_secs(5);
    while stops_pending() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(!stops_pending(), "still pending after its group went");
    settle_stops();
    // The grace reaped it (ECHILD here) once SIGTERM ended it.
    let _reaped = child.wait();
}

/// Refused a thread for the grace, the stop neither panics nor kills at once: it runs the grace
/// itself, so the group keeps its two seconds and is gone, with nothing listed, when it returns.
#[test]
fn a_refused_grace_thread_runs_the_grace_in_the_stop() {
    let _turn = turn();
    let mut child = deaf_group();
    let started = Instant::now();
    unix::stop_with(pid(&child), |_grace| {
        Err(io::Error::from(io::ErrorKind::WouldBlock))
    });
    assert!(
        started.elapsed() >= Duration::from_millis(1900),
        "killed before its grace"
    );
    assert!(!alive(pid(&child)), "left alive after its grace");
    assert!(!stops_pending());
    assert_eq!(unix::listed(), 0);
    let _reaped = child.wait();
}

/// A new stop prunes the graces that finished: the list keeps only what still waits.
#[test]
fn a_second_stop_prunes_a_finished_grace() {
    let _turn = turn();
    let mut gone = Command::new("sleep")
        .arg("10")
        .process_group(0)
        .spawn()
        .unwrap();
    drop(GroupGuard::new(Some(gone.id())));
    let deadline = Instant::now() + Duration::from_secs(5);
    while stops_pending() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        unix::listed(),
        1,
        "the finished grace stays listed until pruned"
    );
    let mut deaf = deaf_group();
    drop(GroupGuard::new(Some(deaf.id())));
    assert_eq!(
        unix::listed(),
        1,
        "the finished grace is pruned, the new one listed"
    );
    assert!(stops_pending());
    settle_stops();
    let _reaped = (gone.wait(), deaf.wait());
}

/// Only a grace still running counts: a thread that finished but was never joined does not.
#[test]
fn a_finished_grace_left_unjoined_is_not_running() {
    let finished = std::thread::spawn(|| {});
    while !finished.is_finished() {
        std::thread::yield_now();
    }
    let (release, held) = std::sync::mpsc::channel::<()>();
    let holding = std::thread::spawn(move || {
        let _released = held.recv();
    });
    let mut threads = vec![finished];
    assert!(!unix::running(&threads));
    threads.push(holding);
    assert!(unix::running(&threads));
    release.send(()).unwrap();
    for thread in threads {
        thread.join().unwrap();
    }
}
