//! craft's own exit over a real stopped group: `finish`, as `main` calls it, waits out the grace of
//! a group that ignores SIGTERM and kills it before it returns.

use std::process::ExitCode;
use std::time::{Duration, Instant};

use super::{Bench, HostKind, SETTLING, Spec};

/// Whether the group `pgid` leads still has a member.
fn alive(pgid: &str) -> bool {
    std::process::Command::new("kill")
        .args(["-0", "--", &format!("-{pgid}")])
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap()
        .success()
}

/// Run without its settle, or with a pending check that says no, `finish` would return at once,
/// with the deaf group still inside its two-second grace.
#[tokio::test]
async fn craft_s_exit_kills_a_stopped_group_that_ignores_sigterm() {
    let _turn = SETTLING.lock().await;
    let mut bench = Bench::new(HostKind::Codex);
    bench.stop_after = Some((Duration::from_millis(500), 143));
    let fake = bench.fake(vec![Spec("deaf", "DEAF", None)]);
    let _answer = bench.drive(&fake).await;
    let pid: String = std::fs::read_dir(bench.path("log"))
        .unwrap()
        .find_map(|e| {
            let name = e.unwrap().file_name().to_string_lossy().into_owned();
            name.strip_prefix("call-").map(str::to_owned)
        })
        .unwrap();
    let code = crate::finish(Ok(ExitCode::from(7))).await;
    assert_eq!(code, ExitCode::from(7));
    // What SIGKILL left, such as the shell's own child, is gone within moments; a group still
    // inside its grace is not.
    let gone_by = Instant::now() + Duration::from_millis(500);
    while alive(&pid) && Instant::now() < gone_by {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(!alive(&pid), "the deaf group {pid} outlived craft's exit");
}
