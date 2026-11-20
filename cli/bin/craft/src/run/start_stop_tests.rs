//! A stopping signal while the binary opens the run: the start is told to stop, and the run ends
//! as stopped, filed INCOMPLETE and named for its resume, with no round run.

use std::time::{Duration, Instant};

use super::{Bench, HostKind, Spec};

// Multi-threaded, as `main`'s runtime is: the start blocks the driving thread.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stop_during_a_slow_start_ends_the_run_promptly_as_stopped_and_resumable() {
    let mut bench = Bench::new(HostKind::Codex);
    bench.stop_after = Some((Duration::from_millis(300), 130));
    let mut fake = bench.fake(vec![Spec("a", "do a", None)]);
    fake.slow_start = Some(std::cell::Cell::new(false));
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
    assert!(
        answer
            .text
            .contains("INCOMPLETE — review run was stopped by a signal (exit 130)"),
        "{}",
        answer.text
    );
    assert!(answer.text.contains("To resume it"), "{}", answer.text);
    assert_eq!(answer.run, Some(bench.path("run").display().to_string()));
    assert!(fake.submits.borrow().is_empty(), "nothing is submitted");
    assert!(bench.calls().is_empty(), "no task ran");
    assert_eq!(
        *fake.filed.borrow(),
        ["review run was stopped by a signal (exit 130)"]
    );
}
