//! `--unverified` against git's own variety: per-run heads, uncommitted work, encodings and the
//! user's diff configuration (realm @nick/craft, #636).

use serde_json::json;

use super::unverified::{branches, commit, git, record, repo, unverified};

#[test]
fn each_run_is_held_to_its_own_head() {
    let s = repo();
    let old = commit(&s, "1\n2\n3\n");
    record(&s, "a", &old, &json!([unverified(2)]));
    let new = commit(&s, "1\nX\n3\n");
    record(&s, "b", &new, &json!([unverified(2)]));
    record(&s, "c", &new, &json!([unverified(2)]));
    let out = s.read(&["--unverified"]);
    assert_eq!(branches(&out), [json!(["b", "c"])]);
    assert_eq!(out["unverified"]["changed"], 1);
}

#[test]
fn a_run_that_read_uncommitted_work_is_kept_unchecked() {
    let s = repo();
    let head = commit(&s, "1\n2\n3\n");
    for branch in ["a", "b"] {
        let rec = json!({"project": s.project, "branch": branch, "ts": branch, "head": head,
            "dirty": true, "ledger": [unverified(2)]});
        s.write(branch, &rec);
    }
    commit(&s, "1\nX\n3\n");
    let out = s.read(&["--unverified"]);
    assert_eq!(branches(&out), [json!(["a", "b"])]);
    assert_eq!(out["unverified"]["unchecked"], 2);
    assert_eq!(out["unverified"]["changed"], 0);
}

#[test]
fn a_file_in_a_legacy_encoding_is_still_held_to_its_lines() {
    let s = repo();
    std::fs::write(s.project.join("a.rs"), b"1\ncaf\xe9\n3\n").unwrap();
    git(&s, &["add", "a.rs"]);
    git(&s, &["commit", "-qm", "latin-1"]);
    let head = git(&s, &["rev-parse", "HEAD"]);
    record(&s, "a", &head, &json!([unverified(2)]));
    record(&s, "b", &head, &json!([unverified(3)]));
    std::fs::write(s.project.join("a.rs"), b"1\nd\xe8j\xe0\n3\n").unwrap();
    git(&s, &["commit", "-qam", "edit"]);
    let out = s.read(&["--unverified"]);
    assert_eq!(out["unverified"]["groups"], json!([]));
    assert_eq!(out["unverified"]["changed"], 1);
    assert_eq!(out["unverified"]["unchecked"], 0);
}

#[test]
fn a_relative_diff_setting_and_a_subdirectory_project_do_not_hide_a_change() {
    let s = repo();
    git(&s, &["config", "diff.relative", "true"]);
    std::fs::create_dir(s.project.join("sub")).unwrap();
    let head = commit(&s, "1\n2\n");
    record(&s, "a", &head, &json!([unverified(2)]));
    record(&s, "b", &head, &json!([unverified(2)]));
    commit(&s, "1\nX\n");
    let out = s
        .command()
        .args(["runs", "--store"])
        .arg(&s.store)
        .args(["recurring", "--unverified", "--project"])
        .arg(s.project.join("sub"))
        .output()
        .unwrap();
    assert_eq!(
        out.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let out: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(out["unverified"]["changed"], 2);
}
