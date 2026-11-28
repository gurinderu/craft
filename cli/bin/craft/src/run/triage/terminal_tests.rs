use super::*;

#[tokio::test]
async fn the_loop_accepts_a_held_status_as_terminal_before_running_any_tasks() {
    let b = Bench::new(HostKind::Codex);
    let mut f = fake(&b, None);
    f.first = Some(
        json!({"run":b.path("run"),"done":false,"stopped":{"text":"held"},"planFile":"stale"}),
    );
    let a = b.drive(&f).await;
    assert!(!a.finished);
    assert!(a.text.contains("Triage stopped: held"));
    assert!(!a.text.contains("filed again"));
    assert!(f.calls.borrow().is_empty());
    assert!(b.calls().is_empty());
}

#[tokio::test]
async fn recovery_validates_the_terminal_file_and_never_advertises_an_invalid_plan() {
    for plan in [
        "{bad",
        r#"{"plan_markdown":"x","summary":"x","ledger":[{}]}"#,
    ] {
        let b = Bench::new(HostKind::Codex);
        let path = b.path("run/plan.json");
        std::fs::write(&path, plan).unwrap();
        let f = fake(
            &b,
            Some(
                json!({"done":true,"planFile":path,"summary":"stale", "filing":{"record":"filed"}}),
            ),
        );
        let a = b.drive(&f).await;
        assert!(!a.finished);
        assert!(a.text.contains("Triage incomplete:"));
        assert!(!a.text.contains("The plan is"));
        assert!(a.step.as_ref().unwrap().get("planFile").is_none());
        assert!(a.step.as_ref().unwrap().get("summary").is_none());
    }
}
