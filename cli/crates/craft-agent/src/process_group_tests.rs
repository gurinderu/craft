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

/// Refused a thread for the grace, the stop neither panics nor kills at once: the group keeps
/// its grace, pending until the settle waits it out and sends the SIGKILL.
#[test]
fn a_refused_grace_thread_defers_the_grace_to_the_settle() {
    let _turn = turn();
    let mut child = deaf_group();
    let started = Instant::now();
    unix::stop_with(pid(&child), |_grace| {
        Err(io::Error::from(io::ErrorKind::WouldBlock))
    });
    assert!(stops_pending());
    std::thread::sleep(Duration::from_millis(200));
    assert!(alive(pid(&child)), "killed before its grace");
    settle_stops();
    assert!(started.elapsed() >= Duration::from_millis(1900));
    assert!(!alive(pid(&child)), "left alive after the settle");
    assert!(!stops_pending());
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

/// Only a stop that still waits counts and survives a prune: a running thread and a deferred
/// grace do, a thread that finished but was never joined does not.
#[test]
fn a_finished_grace_left_unjoined_no_longer_waits() {
    let finished = std::thread::spawn(|| {});
    while !finished.is_finished() {
        std::thread::yield_now();
    }
    let (release, held) = std::sync::mpsc::channel::<()>();
    let holding = std::thread::spawn(move || {
        let _released = held.recv();
    });
    let mut stops = vec![
        unix::Stop::Thread(finished),
        unix::Stop::Thread(holding),
        unix::Stop::Deferred {
            pgid: Pid::from_raw(i32::MAX),
            deadline: Instant::now(),
        },
    ];
    let waits: Vec<bool> = stops.iter().map(unix::Stop::waits).collect();
    assert_eq!(waits, [false, true, true]);
    unix::prune(&mut stops);
    assert_eq!(stops.len(), 2);
    release.send(()).unwrap();
    for stop in stops {
        if let unix::Stop::Thread(thread) = stop {
            thread.join().unwrap();
        }
    }
}
