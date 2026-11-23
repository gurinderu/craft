//! A run whose state another craft's format wrote is refused by this binary, and its telemetry
//! is left as honest as it was: an earlier format's run has the records it kept or lost filed again
//! — once, the store's proof knowing one that landed — and nothing new; a newer format's run is
//! left untouched for the craft that wrote it (realm @nick/craft, node #618).
#![cfg(unix)]
#![expect(
    clippy::unwrap_used,
    reason = "the fixture fails the test loudly, like the tests it serves"
)]

mod store_fixture;

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use store_fixture::{as_format, records, started, started_with, submit};

const SUBMITS: [&[&str]; 3] = [&[], &["--limit", "usage limit"], &["--resume"]];

/// `home`'s run store made writable or not: a write into a shut one fails, as a full disk's would.
fn store_open(home: &Path, open: bool) {
    let runs = home.join(".craft/runs");
    std::fs::create_dir_all(&runs).unwrap();
    let mode = if open { 0o755 } else { 0o555 };
    std::fs::set_permissions(&runs, std::fs::Permissions::from_mode(mode)).unwrap();
}

/// The record `run`'s telemetry says its last segment's record is.
fn kept_record(run: &Path) -> Value {
    let kept: Value =
        serde_json::from_slice(&std::fs::read(run.join("filing.json")).unwrap()).unwrap();
    kept.get("record").cloned().unwrap_or(Value::Null)
}

/// A run stopped on the usage limit whose stop record never reached the store: run, home, PATH.
fn stopped_lost(tmp: &Path) -> (PathBuf, PathBuf, String) {
    let (run, home, path, out) = started(tmp);
    assert!(out.status.success());
    store_open(&home, false);
    let stopped = submit(&run, &home, &path, &["--limit", "usage limit"]);
    store_open(&home, true);
    assert!(
        stopped.status.success(),
        "{}",
        String::from_utf8_lossy(&stopped.stderr)
    );
    assert!(records(&home).is_empty());
    assert_eq!(kept_record(&run), json!("failed"));
    (run, home, path)
}

/// `run` submitted with `flags` after its state was rewritten as format 6: refused, with the words.
fn refused_as_earlier(run: &Path, home: &Path, path: &str, flags: &[&str]) {
    as_format(run, 6);
    let said = submit(run, home, path, flags);
    assert!(!said.status.success(), "{flags:?}");
    let err = String::from_utf8_lossy(&said.stderr);
    assert!(
        err.contains("a craft before 0.59.0 (format 6)") && err.contains("`craft review start`"),
        "{flags:?}: {err}"
    );
}

#[test]
fn a_stopped_record_that_never_landed_is_filed_once_whatever_the_submit() {
    for flags in SUBMITS {
        let tmp = tempfile::tempdir().unwrap();
        let (run, home, path) = stopped_lost(tmp.path());
        refused_as_earlier(&run, &home, &path, flags);
        let filed = records(&home);
        assert_eq!(filed.len(), 1, "{flags:?}: the lost record, filed once");
        assert!(
            !filed.iter().any(|r| r.contains("format 6")),
            "{flags:?}: no record of the refusal"
        );
    }
}

#[test]
fn a_stopped_record_that_landed_though_kept_as_failed_is_not_filed_twice() {
    for flags in SUBMITS {
        let tmp = tempfile::tempdir().unwrap();
        let (run, home, path, out) = started(tmp.path());
        assert!(out.status.success());
        assert!(
            submit(&run, &home, &path, &["--limit", "usage limit"])
                .status
                .success()
        );
        assert_eq!(records(&home).len(), 1);
        // Landed, yet the binary did not hear so (its worker timed out): kept as failed.
        let file = run.join("filing.json");
        let mut kept: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        kept.as_object_mut()
            .unwrap()
            .insert("record".into(), json!("failed"));
        std::fs::write(&file, kept.to_string()).unwrap();
        refused_as_earlier(&run, &home, &path, flags);
        assert_eq!(
            records(&home).len(),
            1,
            "{flags:?}: the store's proof knows it landed"
        );
    }
}

#[test]
fn a_finished_runs_record_that_never_landed_is_filed_once_whatever_the_submit() {
    for flags in SUBMITS {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        store_open(&home, false);
        // A change of documentation alone: the run ends at its start, its record not landing.
        let (run, _, path, out) = started_with(tmp.path(), ("notes.md", "n\n"));
        store_open(&home, true);
        let step: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(step["done"], json!(true), "{step}");
        assert!(records(&home).is_empty());
        if flags == ["--resume"] {
            // A finished run's resume re-files its record and ends there, as any format's does.
            as_format(&run, 6);
            let said = submit(&run, &home, &path, flags);
            assert!(
                said.status.success(),
                "{}",
                String::from_utf8_lossy(&said.stderr)
            );
        } else {
            refused_as_earlier(&run, &home, &path, flags);
        }
        assert_eq!(
            records(&home).len(),
            1,
            "{flags:?}: the lost record, filed once"
        );
    }
}

#[test]
fn a_run_a_newer_craft_wrote_is_sent_back_to_it_its_telemetry_untouched() {
    for flags in SUBMITS {
        let tmp = tempfile::tempdir().unwrap();
        // A lost record it could wrongly file again.
        let (run, home, path) = stopped_lost(tmp.path());
        as_format(&run, 99);
        let before = std::fs::read(run.join("filing.json")).unwrap();
        let said = submit(&run, &home, &path, flags);
        assert!(!said.status.success(), "{flags:?}");
        let err = String::from_utf8_lossy(&said.stderr);
        assert!(
            err.contains("a newer craft (format 99)")
                && err.contains("go on with the run under the craft that started it")
                && !err.contains("craft review start"),
            "{flags:?}: {err}"
        );
        assert!(records(&home).is_empty(), "{flags:?}: nothing filed");
        assert_eq!(
            std::fs::read(run.join("filing.json")).unwrap(),
            before,
            "{flags:?}"
        );
    }
}
