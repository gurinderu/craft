//! The triage's event stream end to end, the binary itself run (realm @nick/craft, node #690):
//! a refusal before anything ran ends the way the review's does.

use super::fixture::{Bench, result};

#[test]
fn a_refusal_before_the_host_ends_in_the_event_stream_too() {
    let b = Bench::new();
    let out = b
        .command("opencode", "ok")
        .args([
            "--delegate",
            "--agents",
            "review-task",
            "--prior-ledger",
            "-",
            "--report",
            "r",
        ])
        .output()
        .unwrap();
    b.expect(&out, 2);
    // The refusal is the stream's one event, its answer on stdout: the same end as the review's.
    let event = result(&out);
    assert_eq!(event["exit_code"], 2);
    assert!(event["run"].is_null(), "{event}");
    assert_eq!(
        String::from_utf8_lossy(&out.stderr).lines().count(),
        1,
        "the refusal is the stream's one event"
    );
    let answer = String::from_utf8_lossy(&out.stdout);
    assert!(answer.contains("Triage refused"), "{answer}");
    assert!(answer.contains("--delegate cannot share stdin"), "{answer}");
    assert!(answer.contains("Nothing ran"), "{answer}");
    assert!(b.calls().is_empty());
}
