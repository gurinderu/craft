use std::io::{self, Read as _};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use nix::unistd::Pid;

use super::{GroupGuard, settle_stops, stops_pending, unix};

/// The stop list is the process's own: the tests that stop a group take turns, so one test's
/// grace is not another's pending stop.
static TURN: Mutex<()> = Mutex::new(());

fn turn() -> MutexGuard<'static, ()> {
    TURN.lock().unwrap_or_else(PoisonError::into_inner)
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
    // The grace ended in SIGKILL, which its thread does not reap: the killed child is reaped here.
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

/// Refused a thread for the grace, the stop sends SIGKILL at once instead of panicking.
#[test]
fn a_refused_grace_thread_kills_the_group_at_once() {
    let _turn = turn();
    let mut child = deaf_group();
    let started = Instant::now();
    unix::stop_with(pid(&child), |_grace| {
        Err(io::Error::from(io::ErrorKind::WouldBlock))
    });
    let status = child.wait().unwrap();
    assert_eq!(status.signal(), Some(9), "{status:?}");
    assert!(started.elapsed() < Duration::from_secs(1));
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
