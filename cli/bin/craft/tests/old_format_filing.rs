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

use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use store_fixture::{as_format, comment, records, started, started_with, submit};

const SUBMITS: [&[&str]; 3] = [&[], &["--limit", "usage limit"], &["--resume"]];

/// The checkout's own Claude Code delivery: a plugin root a submit can be told of.
const ROOT: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../integrations/claude-code"
);

/// `home`'s run store blocked or restored: blocked, a regular file stands where the store's
/// directory is (the store itself set aside), so every write into it fails for any user, root
/// included, as a full disk's would; restored, the store is back as it was.
fn store_blocked(home: &Path, blocked: bool) {
    let (runs, held) = (home.join(".craft/runs"), home.join(".craft/runs.held"));
    if blocked {
        std::fs::create_dir_all(home.join(".craft")).unwrap();
        if runs.exists() {
            std::fs::rename(&runs, &held).unwrap();
        }
        std::fs::write(&runs, "not a directory").unwrap();
    } else {
        std::fs::remove_file(&runs).unwrap();
        if held.exists() {
            std::fs::rename(&held, &runs).unwrap();
        }
    }
}

/// `run`'s telemetry as a run whose plugin root was since uninstalled keeps it: a submit told of
/// one would adopt it, rewriting the telemetry.
fn uprooted(run: &Path) {
    let file = run.join("filing.json");
    let mut kept: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    let ctx = kept.get_mut("ctx").and_then(Value::as_object_mut).unwrap();
    ctx.insert("root".into(), json!("/gone/craft"));
    std::fs::write(&file, kept.to_string()).unwrap();
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
    store_blocked(&home, true);
    let stopped = submit(&run, &home, &path, &["--limit", "usage limit"]);
    store_blocked(&home, false);
    assert!(
        stopped.status.success(),
        "{}",
        String::from_utf8_lossy(&stopped.stderr)
    );
    assert_eq!(records(&home), Vec::<String>::new());
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
        let (run, home, path) = landed_kept_failed(tmp.path(), false);
        refused_as_earlier(&run, &home, &path, flags);
        assert_eq!(
            records(&home).len(),
            1,
            "{flags:?}: the store's proof knows it landed"
        );
    }
}

/// A run finished at its start (a change of documentation alone) whose record never reached the
/// store: run, home, PATH.
fn finished_lost(tmp: &Path) -> (PathBuf, PathBuf, String) {
    let home = tmp.join("home");
    store_blocked(&home, true);
    let (run, _, path, out) = started_with(tmp, ("notes.md", "n\n"));
    store_blocked(&home, false);
    let step: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(step.get("done"), Some(&json!(true)), "{step}");
    assert_eq!(records(&home), Vec::<String>::new());
    (run, home, path)
}

#[test]
fn a_finished_runs_record_that_never_landed_is_filed_once_whatever_the_submit() {
    for flags in SUBMITS {
        let tmp = tempfile::tempdir().unwrap();
        let (run, home, path) = finished_lost(tmp.path());
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

/// A run whose record landed, `finished` at its start (a change of documentation alone) or
/// stopped on the usage limit, though its telemetry keeps the record as failed (its worker timed
/// out): a submit that wrongly files it again rewrites that telemetry. Run, home, PATH.
fn landed_kept_failed(tmp: &Path, finished: bool) -> (PathBuf, PathBuf, String) {
    let (run, home, path, out) = if finished {
        started_with(tmp, ("notes.md", "n\n"))
    } else {
        started(tmp)
    };
    assert!(out.status.success());
    if !finished {
        assert!(
            submit(&run, &home, &path, &["--limit", "usage limit"])
                .status
                .success()
        );
    }
    assert_eq!(records(&home).len(), 1);
    let file = run.join("filing.json");
    let mut kept: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    kept.as_object_mut()
        .unwrap()
        .insert("record".into(), json!("failed"));
    std::fs::write(&file, kept.to_string()).unwrap();
    (run, home, path)
}

/// `run`, rewritten as format 99 with its plugin root uprooted, put to `craft` through `said`
/// (told of a plugin root it could adopt): refused with the newer craft's words, nothing filed,
/// its telemetry byte for byte as it was.
fn untouched_as_newer(run: &Path, home: &Path, said: impl Fn(&[&str]) -> std::process::Output) {
    assert!(
        Path::new(ROOT).join(".claude-plugin/plugin.json").is_file(),
        "{ROOT} is a plugin root a run could adopt"
    );
    as_format(run, 99);
    uprooted(run);
    let (before, filed) = (
        std::fs::read(run.join("filing.json")).unwrap(),
        records(home),
    );
    let out = said(&["--record-root", ROOT]);
    assert!(!out.status.success());
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(
        err.contains("a newer craft (format 99)")
            && err.contains("go on with the run under the craft that started it")
            && !err.contains("craft review start"),
        "{err}"
    );
    assert_eq!(records(home), filed, "nothing filed");
    assert_eq!(std::fs::read(run.join("filing.json")).unwrap(), before);
}

#[test]
fn a_run_a_newer_craft_wrote_is_sent_back_to_it_its_telemetry_untouched() {
    for flags in SUBMITS {
        for finished in [false, true] {
            let tmp = tempfile::tempdir().unwrap();
            // A record it could wrongly file again, and a root it could adopt.
            let (run, home, path) = landed_kept_failed(tmp.path(), finished);
            untouched_as_newer(&run, &home, |root| {
                submit(&run, &home, &path, &[flags, root].concat())
            });
        }
    }
}

#[test]
fn a_comment_on_a_run_a_newer_craft_wrote_leaves_its_telemetry_untouched() {
    let tmp = tempfile::tempdir().unwrap();
    let (run, home, path) = landed_kept_failed(tmp.path(), true);
    untouched_as_newer(&run, &home, |root| comment(&run, &home, &path, root));
}
