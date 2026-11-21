use serde_json::json;

use super::support::Store;

#[test]
fn missing_store_omits_skipped_and_malformed_cli_exits_two() {
    let s = Store::new();
    std::fs::remove_dir(&s.store).unwrap();
    let out = s.read(&[]);
    assert_eq!(
        out,
        json!({"store":s.store,"project":s.project,"paths":[],"runsRead":0,
        "runsNotRead":0,"groups":[],"groupsCut":0,
        "note":format!("no run store at {} — no recurrence to show",s.store.display())})
    );
    for flag in ["--store", "--project", "--path", "--unknown"] {
        let result = s
            .command()
            .args(["runs", "recurring", flag])
            .output()
            .unwrap();
        assert_eq!(result.status.code(), Some(2), "{flag}");
        assert!(result.stdout.is_empty());
    }
    let result = s
        .command()
        .args(["runs", "recurring", "--path", "--json"])
        .output()
        .unwrap();
    assert_eq!(result.status.code(), Some(2));
}

#[test]
fn absent_and_explicit_empty_store_and_project_use_the_defaults() {
    let s = Store::new();
    let read = |extra: &[&str]| {
        let out = s
            .command()
            .args(["runs", "recurring"])
            .args(extra)
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(0));
        serde_json::from_slice::<serde_json::Value>(&out.stdout).unwrap()
    };
    let expected = read(&[]);
    assert_eq!(expected["project"], json!(s.project));
    assert_eq!(expected["store"], json!(s.root.path().join(".craft/runs")));
    assert_eq!(expected, read(&["--store", "", "--project", ""]));
}
