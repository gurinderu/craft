use serde_json::json;

use super::*;

#[test]
fn a_stop_wins_over_a_failed_or_missing_plan_and_done_false() {
    assert_eq!(
        outcome(
            &json!({"done":false,"stopped":{"text":"held"},"failed":"failed","planFile":"absent"})
        )
        .unwrap(),
        Outcome::Stopped("held".into())
    );
}

#[test]
fn failed_and_missing_plans_never_count_as_success() {
    for step in [
        json!({"done":true,"failed":"plan died"}),
        json!({"done":true}),
        json!({"done":true,"planFile":"/absent/plan.json"}),
    ] {
        outcome(&step).unwrap_err();
    }
}

#[test]
fn malformed_plan_fields_are_rejected() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().join("plan.json");
    for (key, value) in [
        ("summary", json!(1)),
        ("plan_markdown", json!(null)),
        ("ledger", json!([{}])),
        (
            "ledger",
            json!([{"stable_id":"x", "verdict":1, "reason":"y"}]),
        ),
        ("notRun", json!(false)),
        ("notRun", json!([1])),
        ("memoryDegraded", json!(true)),
    ] {
        let mut plan = json!({"summary":"s","plan_markdown":"m","ledger":[]});
        plan[key] = value;
        std::fs::write(&path, plan.to_string()).unwrap();
        assert!(
            outcome(&json!({"done":true,"planFile":path})).is_err(),
            "{plan}"
        );
    }
}

#[test]
fn string_fields_keep_javascript_utf16_and_only_display_lossily() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().join("plan.json");
    let plan = r#"{"summary":"\ud800","plan_markdown":"\ud800","ledger":[{"stable_id":"\ud800","verdict":"accept","reason":"\ud800"}],"memoryDegraded":["\ud800"]}"#;
    std::fs::write(&path, plan).unwrap();
    let got = outcome(&json!({"done":true,"planFile":path})).unwrap();
    assert_eq!(
        got,
        Outcome::Plan {
            complete: true,
            summary: "�".into(),
            notes: vec!["�".into()]
        }
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), plan);
}
