//! How a run ends, refused or driven (realm @nick/craft, node #690): the exit waits for what the
//! run offered, and the result is the last line written.

use std::sync::Arc;
use std::time::Duration;

use super::events::stream::{self, Kept};
use super::events::{Event, Sink};
use super::{ExitCode, ended};

#[test]
fn the_run_s_exit_waits_for_what_it_offered_and_writes_the_result_last() {
    let kept = Arc::new(Kept::slow(Duration::from_millis(2)));
    let sink = Sink::with(true, 256, Duration::from_secs(5), stream::writing(&kept));
    for key in 0..64u64 {
        sink.emit(Event::TaskCancelled { key });
    }
    let exit = ended(
        &sink,
        "## Verdict: INCOMPLETE",
        Event::result(None, None, 1),
        1,
    )
    .unwrap();
    let lines = kept.lines();
    let last = lines
        .last()
        .map(|line| serde_json::from_str::<Event>(line).unwrap());
    assert_eq!(
        lines.len(),
        65,
        "what the run offered was written before the exit"
    );
    assert_eq!(
        last,
        Some(Event::result(None, None, 1)),
        "the result is the last line written"
    );
    assert_eq!(exit, ExitCode::from(1));
}
