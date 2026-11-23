//! `craft review post` choosing its record and reading the review's own dirty flag: the run's
//! `diff.dirty`, not the filing's look at the checkout; a named record past a newer review of
//! the branch; no record, or another branch's newest, refused with nothing posted.

use serde_json::{Value, json};

use super::support::{Posting, text};

fn choices(file: &std::path::Path) -> Value {
    let r: Value = serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
    r["sorting"].get("choices").cloned().unwrap_or(Value::Null)
}

#[test]
fn the_reviews_own_dirty_flag_decides_not_the_filings() {
    // The filing saw an untracked file; the review read committed work only.
    let f = Posting::with(&json!({"dirty": true}));
    std::fs::write(f.repo.join("scratch.txt"), "x").unwrap();
    let out = f.post(&["--n", "1", "--as", "question"]);
    assert!(out.status.success(), "{}", text(&out.stderr));
    std::fs::remove_file(f.bin.join("sent.json")).unwrap();
    f.review(true);
    let dirty = f.post(&["--n", "1", "--as", "question"]);
    assert_eq!(dirty.status.code(), Some(1), "{}", text(&dirty.stderr));
    assert!(
        text(&dirty.stderr).contains("uncommitted changes"),
        "{}",
        text(&dirty.stderr)
    );
    assert!(!f.bin.join("sent.json").exists(), "nothing posted");
}

/// `craft review post` exits 2, nothing posted, saying `said`.
fn refused(f: &Posting, said: &str) {
    let out = f.post(&["--n", "1", "--as", "question"]);
    assert_eq!(out.status.code(), Some(2), "{}", text(&out.stderr));
    let err = text(&out.stderr);
    assert!(
        err.contains(said) && err.contains("cannot be told: nothing posted"),
        "{err}"
    );
    assert!(!f.bin.join("sent.json").exists(), "nothing posted");
}

#[test]
fn a_run_that_cannot_tell_uncommitted_work_is_refused_with_2() {
    let f = Posting::with(&json!({"cliRun": ""}));
    refused(&f, "names no review run directory (cliRun)");
    let f = Posting::new();
    std::fs::write(f.run.join("state.json"), "{ not json").unwrap();
    refused(
        &f,
        "the review's run state cannot be read (parsing the run state",
    );
    std::fs::write(f.run.join("state.json"), r#"{"version": 6, "diff": {}}"#).unwrap();
    refused(&f, "names no diff.dirty");
    std::fs::remove_file(f.run.join("state.json")).unwrap();
    refused(
        &f,
        "the review's run state cannot be read (reading the run state",
    );
    std::fs::remove_dir_all(&f.run).unwrap();
    refused(&f, "is gone");
}

/// A record of `branch` newer than the fixture's, its finding 1 titled `title`.
fn newer(f: &Posting, branch: &str, title: &str) -> std::path::PathBuf {
    let file = f
        .store
        .path()
        .join("2026-11-02T10-00-00Z-workflow-review.json");
    let finding = json!({"n": 1, "severity": "Medium", "title": title, "file": "a.rs", "line": 3, "why": "w", "fix": "f", "source": "intent", "toolRule": "", "outsideDiff": false});
    let r = json!({"project": f.repo, "branch": branch, "head": f.head, "cliRun": f.run, "sorting": {"defect": 0, "doubtful": 1, "inDiffJudged": true, "findings": [finding]}});
    std::fs::write(&file, serde_json::to_string_pretty(&r).unwrap()).unwrap();
    file
}

#[test]
fn a_named_record_is_posted_from_past_a_newer_review_of_the_branch() {
    let f = Posting::new();
    let later = newer(&f, "feat/x", "a newer finding");
    let record = f.record.to_str().unwrap();
    let out = f.post(&["--n", "1", "--as", "question", "--record", record]);
    assert!(out.status.success(), "{}", text(&out.stderr));
    let said: Value = serde_json::from_str(&text(&out.stdout)).unwrap();
    assert_eq!(said["record"], json!(record));
    let sent: Value =
        serde_json::from_str(&std::fs::read_to_string(f.bin.join("sent.json")).unwrap()).unwrap();
    assert!(
        sent["body"].as_str().unwrap().starts_with("[Medium] t\n"),
        "{sent}"
    );
    assert_eq!(choices(&f.record)["1"]["choice"], json!("question"));
    assert_eq!(
        choices(&later),
        Value::Null,
        "the newer record is left alone"
    );
}

#[test]
fn no_record_or_another_branchs_newest_is_refused_with_2() {
    let f = Posting::new();
    newer(&f, "other", "another branch's");
    let other = f.post(&["--n", "1", "--as", "question"]);
    assert_eq!(other.status.code(), Some(2), "{}", text(&other.stderr));
    assert!(
        text(&other.stderr).contains("is of branch \"other\", not \"feat/x\""),
        "{}",
        text(&other.stderr)
    );
    for e in std::fs::read_dir(f.store.path()).unwrap() {
        std::fs::remove_file(e.unwrap().path()).unwrap();
    }
    let none = f.post(&["--n", "1", "--as", "question"]);
    assert_eq!(none.status.code(), Some(2), "{}", text(&none.stderr));
    assert!(
        text(&none.stderr).contains("carries doubtful findings"),
        "{}",
        text(&none.stderr)
    );
    assert!(!f.bin.join("sent.json").exists(), "nothing posted");
}

#[test]
fn a_run_state_of_another_format_version_still_tells_uncommitted_work() {
    let f = Posting::new();
    let path = f.run.join("state.json");
    let mut state: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    state["version"] = json!(999);
    std::fs::write(&path, state.to_string()).unwrap();
    let out = f.post(&["--n", "1", "--as", "question"]);
    assert!(out.status.success(), "{}", text(&out.stderr));
    std::fs::remove_file(f.bin.join("sent.json")).unwrap();
    state["diff"]["dirty"] = json!(true);
    std::fs::write(&path, state.to_string()).unwrap();
    let dirty = f.post(&["--n", "1", "--as", "question"]);
    assert_eq!(dirty.status.code(), Some(1), "{}", text(&dirty.stderr));
}
