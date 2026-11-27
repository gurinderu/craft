//! `--unverified`: unverified findings grouped apart, held to their lines (realm @nick/craft, #636).

use serde_json::{Value, json};

use super::support::{Store, row};

pub(super) const ABSENT_HEAD: &str = "0123456789abcdef0123456789abcdef01234567";

pub(super) fn git(s: &Store, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(&s.project)
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

pub(super) fn repo() -> Store {
    let s = Store::new();
    git(&s, &["init", "-q", "-b", "main"]);
    s
}

pub(super) fn commit(s: &Store, text: &str) -> String {
    std::fs::write(s.project.join("a.rs"), text).unwrap();
    git(s, &["add", "a.rs"]);
    git(s, &["commit", "-qm", "c"]);
    git(s, &["rev-parse", "HEAD"])
}

pub(super) fn unverified(line: u32) -> Value {
    let mut r = row("a.rs", "unwrap in parser may panic");
    let o = r.as_object_mut().unwrap();
    for (k, v) in [
        ("tier", json!("unverified")),
        ("severity", json!("Low")),
        ("line", json!(line)),
    ] {
        drop(o.insert(k.into(), v));
    }
    r
}

pub(super) fn record(s: &Store, branch: &str, head: &str, ledger: &Value) {
    let rec = json!({"project": s.project, "branch": branch, "ts": branch, "head": head, "ledger": ledger});
    s.write(branch, &rec);
}

pub(super) fn branches(out: &Value) -> Vec<Value> {
    let groups = out
        .pointer("/unverified/groups")
        .unwrap()
        .as_array()
        .unwrap();
    groups.iter().map(|g| g["branches"].clone()).collect()
}

#[test]
fn unverified_findings_group_apart_and_only_on_request() {
    let s = repo();
    let head = commit(&s, "1\n2\n3\n");
    record(&s, "a", &head, &json!([unverified(2)]));
    record(&s, "b", &head, &json!([unverified(2)]));
    let plain = s.read(&[]);
    assert_eq!(plain["groups"], json!([]));
    assert!(plain.get("unverified").is_none());
    let out = s.read(&["--unverified"]);
    assert_eq!(out["groups"], json!([]));
    assert_eq!(branches(&out), [json!(["a", "b"])]);
    assert_eq!(out["unverified"]["changed"], 0);
    assert_eq!(out["unverified"]["unchecked"], 0);
    assert!(out["note"].as_str().unwrap().contains("under `unverified`"));
}

#[test]
fn a_confirmed_and_an_unverified_finding_do_not_make_a_group() {
    let s = repo();
    let head = commit(&s, "1\n2\n3\n");
    let mut confirmed = unverified(2);
    confirmed["tier"] = json!("confirmed");
    record(&s, "a", &head, &json!([confirmed]));
    record(&s, "b", &head, &json!([unverified(2)]));
    let out = s.read(&["--unverified"]);
    assert_eq!(out["groups"], json!([]));
    assert_eq!(out["unverified"]["groups"], json!([]));
}

#[test]
fn a_finding_whose_line_changed_since_its_head_is_set_aside() {
    let s = repo();
    let head = commit(&s, "1\n2\n3\n4\n");
    record(&s, "a", &head, &json!([unverified(2)]));
    record(&s, "b", &head, &json!([unverified(4)]));
    record(&s, "c", &head, &json!([unverified(4)]));
    commit(&s, "1\nX\n3\n4\n");
    let out = s.read(&["--unverified"]);
    assert_eq!(branches(&out), [json!(["b", "c"])]);
    assert_eq!(out["unverified"]["changed"], 1);
    commit(&s, "1\nX\n3\nY\n");
    let out = s.read(&["--unverified"]);
    assert_eq!(out["unverified"]["groups"], json!([]));
    assert_eq!(out["unverified"]["changed"], 3);
}

#[test]
fn a_finding_naming_no_line_is_set_aside_by_any_edit_of_its_file() {
    let s = repo();
    let head = commit(&s, "1\n2\n");
    record(&s, "a", &head, &json!([unverified(0)]));
    record(&s, "b", &head, &json!([unverified(0)]));
    assert_eq!(branches(&s.read(&["--unverified"])).len(), 1);
    commit(&s, "1\n2\n3\n");
    let out = s.read(&["--unverified"]);
    assert_eq!(out["unverified"]["groups"], json!([]));
    assert_eq!(out["unverified"]["changed"], 2);
}

#[test]
fn a_head_this_clone_lacks_keeps_the_finding_unchecked() {
    let s = repo();
    commit(&s, "1\n2\n");
    record(&s, "a", ABSENT_HEAD, &json!([unverified(1)]));
    record(&s, "b", "", &json!([unverified(1)]));
    record(&s, "c", "--stat", &json!([unverified(1)]));
    let out = s.read(&["--unverified"]);
    assert_eq!(branches(&out), [json!(["a", "b", "c"])]);
    assert_eq!(out["unverified"]["unchecked"], 3);
    assert_eq!(out["unverified"]["changed"], 0);
}

#[test]
fn an_absent_store_still_answers_the_unverified_field() {
    let s = repo();
    std::fs::remove_dir(&s.store).unwrap();
    let out = s.read(&["--unverified"]);
    assert_eq!(
        out["unverified"],
        json!({"groups": [], "groupsCut": 0, "changed": 0, "unchecked": 0})
    );
}
