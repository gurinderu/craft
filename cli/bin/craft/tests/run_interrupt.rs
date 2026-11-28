//! A stopped `craft review run`, end to end (realm @nick/craft, node #40): a host's tool stops it
//! with SIGTERM to craft alone — the OpenCode and pi tools kill the process they spawned, the
//! wrapper having `exec`ed into craft — while a task's process and its grandchild run in a group of
//! their own. craft stops that group, files the run INCOMPLETE, says how to resume it, and exits
//! with 128 + 15 — its record naming the host its tasks ran in (`runtime`). A stop while the start
//! is still in the gate (realm @nick/craft, node #544) ends it at once, kills the gate's tool with
//! what it started, and asks for a fresh review.
#![cfg(target_os = "linux")]
#![expect(
    clippy::unwrap_used,
    reason = "the fixture helpers fail the test loudly, like the tests they serve"
)]

#[path = "../../../test-support/blocked.rs"]
mod blocked;
mod common;
#[path = "run_interrupt/fixture.rs"]
mod fixture;
#[path = "run_interrupt/stdin.rs"]
mod stdin;

use std::time::{Duration, Instant};

use fixture::{Bench, all_gone, signal, wait_until};

/// A stand-in `codex exec` that hangs with a grandchild, both pids recorded beside it.
const HANGING_CODEX: &str = "#!/bin/sh\ncat > /dev/null\nsleep 300 &\necho $! > \"$(dirname \"$0\")/grandchild\"\necho $$ > \"$(dirname \"$0\")/pid.tmp\"; mv \"$(dirname \"$0\")/pid.tmp\" \"$(dirname \"$0\")/pid\"\nwait\n";

/// A stand-in `cargo` as a slow gate's: any command hangs with a child, both pids recorded beside it.
const HANGING_CARGO: &str = "#!/bin/sh\nsleep 300 &\necho $! > \"$(dirname \"$0\")/cargo-child\"\necho $$ > \"$(dirname \"$0\")/cargo.tmp\"; mv \"$(dirname \"$0\")/cargo.tmp\" \"$(dirname \"$0\")/cargo-pid\"\nwait\n";

#[test]
fn sigterm_to_craft_stops_the_tasks_and_files_the_run_incomplete() {
    let bench = Bench::new();
    common::write_executable(&bench.bin.join("codex"), HANGING_CODEX).unwrap();
    let craft = bench.review(false);
    wait_until("a task started", Duration::from_secs(30), || {
        bench.bin.join("pid").exists()
    });
    signal(&craft, "-TERM");
    let out = craft.wait_with_output().unwrap();
    let (stdout, stderr) = (
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
    );
    assert_eq!(out.status.code(), Some(143), "{stdout}\n{stderr}");
    assert!(
        stdout.contains("INCOMPLETE — review run was stopped by a signal (exit 143)"),
        "{stdout}"
    );
    assert!(stdout.contains("To resume it"), "{stdout}");
    all_gone(&bench.bin, &["pid", "grandchild"]);
    let filed = bench.filed();
    assert_eq!(filed.len(), 1, "one record is filed");
    assert!(filed[0].contains("INCOMPLETE"), "{}", filed[0]);
    let record: serde_json::Value = serde_json::from_str(&filed[0]).unwrap();
    assert_eq!(
        record["runtime"],
        serde_json::json!("codex"),
        "the record names the host its tasks ran in, not claude-code"
    );
}

#[test]
fn sigint_while_the_start_is_in_the_gate_ends_it_promptly_and_kills_the_gate_s_tools() {
    let bench = Bench::new();
    common::write_executable(&bench.bin.join("codex"), HANGING_CODEX).unwrap();
    common::write_executable(&bench.bin.join("cargo"), HANGING_CARGO).unwrap();
    let craft = bench.review(true);
    wait_until("the gate's cargo started", Duration::from_secs(30), || {
        bench.bin.join("cargo-pid").exists()
    });
    let stopped = Instant::now();
    signal(&craft, "-INT");
    let out = craft.wait_with_output().unwrap();
    let took = stopped.elapsed();
    let (stdout, stderr) = (
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
    );
    assert!(
        took < Duration::from_secs(10),
        "{took:?}\n{stdout}\n{stderr}"
    );
    assert_eq!(out.status.code(), Some(130), "{stdout}\n{stderr}");
    assert!(
        stdout.contains(
            "INCOMPLETE — review run was stopped by a signal (exit 130) while it started"
        ),
        "{stdout}"
    );
    assert!(stdout.contains("Start a fresh review"), "{stdout}");
    assert!(!stdout.contains("To resume it"), "{stdout}");
    assert!(!bench.bin.join("pid").exists(), "no task ran");
    all_gone(&bench.bin, &["cargo-pid", "cargo-child"]);
}
