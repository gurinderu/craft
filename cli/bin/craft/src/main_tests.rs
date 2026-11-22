use std::process::ExitCode;
use std::time::Duration;

use super::finish;

/// With no agent group stopped, `finish` asks the runtime for no blocking thread: the only one it
/// may have is held until `finish` is done, so a `finish` that still asked for one would wait on it
/// and run out the timeout.
#[test]
fn finish_with_no_stopped_group_needs_no_blocking_thread() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .max_blocking_threads(1)
        .enable_time()
        .build()
        .unwrap();
    let (release, held) = std::sync::mpsc::channel::<()>();
    let holder = rt.spawn_blocking(move || {
        let _released = held.recv();
    });
    let finished = rt.block_on(async {
        tokio::time::timeout(Duration::from_secs(5), finish(Ok(ExitCode::SUCCESS))).await
    });
    release.send(()).unwrap();
    rt.block_on(holder).unwrap();
    assert!(
        finished.is_ok(),
        "finish waited for a blocking thread it did not need"
    );
}
