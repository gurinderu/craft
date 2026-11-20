//! A stopping signal while the binary opens the run (realm @nick/craft, node #544): the start is
//! told to stop, and the run ends as stopped, filed INCOMPLETE, with no round run; the answer asks
//! for a fresh review, since a resume would not prepare the cut gate, sources and list again, and
//! keeps the start's own error when it failed.

use std::time::{Duration, Instant};

use super::{Answer, Bench, Fake, HostKind, Spec};

/// A start that runs until stopped by a signal 300 ms in; with `fails`, it then fails so.
async fn stopped_start(fails: Option<&'static str>) -> (Bench, Fake, Answer) {
    let mut bench = Bench::new(HostKind::Codex);
    bench.stop_after = Some((Duration::from_millis(300), 130));
    let mut fake = bench.fake(vec![Spec("a", "do a", None)]);
    fake.slow_start = Some(std::cell::Cell::new(false));
    fake.start_fails = fails;
    let began = Instant::now();
    let answer = bench.drive(&fake).await;
    assert!(
        began.elapsed() < Duration::from_secs(10),
        "{:?}",
        began.elapsed()
    );
    assert_eq!(
        fake.slow_start.as_ref().map(std::cell::Cell::get),
        Some(true)
    );
    assert!(!answer.finished);
    assert!(fake.submits.borrow().is_empty(), "nothing is submitted");
    assert!(bench.calls().is_empty(), "no task ran");
    (bench, fake, answer)
}

const FRESH: &str = "The start was cut short: its gate, sources and consumers list are incomplete, and a resume does not prepare them again. Start a fresh review: this command again, without `--run`.";

// Multi-threaded, as `main`'s runtime is: the start blocks the driving thread.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stop_during_a_slow_start_ends_the_run_promptly_and_asks_for_a_fresh_review() {
    let (bench, fake, answer) = stopped_start(None).await;
    let why = "review run was stopped by a signal (exit 130) while it started";
    assert!(
        answer.text.contains(&format!("INCOMPLETE — {why}")),
        "{}",
        answer.text
    );
    assert!(answer.text.contains(FRESH), "{}", answer.text);
    assert!(!answer.text.contains("To resume it"), "{}", answer.text);
    assert_eq!(answer.run, Some(bench.path("run").display().to_string()));
    assert_eq!(*fake.filed.borrow(), [why]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_start_that_fails_while_stopped_keeps_its_own_error_beside_the_stop() {
    let (_bench, _fake, answer) = stopped_start(Some("the base ref is unknown")).await;
    assert!(
        answer.text.contains(
            "INCOMPLETE — review run was stopped by a signal (exit 130) while it started, and the start failed: the base ref is unknown"
        ),
        "{}",
        answer.text
    );
    assert!(answer.text.contains(FRESH), "{}", answer.text);
    assert_eq!(answer.run, None);
}
