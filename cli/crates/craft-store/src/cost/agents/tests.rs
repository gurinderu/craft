use super::*;

#[test]
fn the_nested_phase_names_its_engine() {
    let of = |p: &str| engine_of_phase(Some(&Js::str(p)));
    assert_eq!(
        of("▸ craft:review"),
        ("▸ craft:review".into(), "review".into())
    );
    assert_eq!(of("▸ craft:review #4").1, "review");
    assert_eq!(of("▸ probe-child #2").1, "probe-child");
    for top in ["Synthesize", "Audit", ""] {
        assert_eq!(of(top), (String::new(), String::new()));
    }
    assert_eq!(engine_of_phase(None), (String::new(), String::new()));
}

#[test]
fn the_logger_labels_and_filed_lines_are_read() {
    for p in [
        &LOG_RUN,
        &FILED,
        &OWN_STEP,
        &RECOVERY_STEP,
        &OWN_KEY,
        &ANY_KEY,
        &NESTED_PHASE,
    ] {
        assert!(p.is_some(), "every pattern compiles");
    }
    assert!(is_match(&LOG_RUN, "log-run") && is_match(&LOG_RUN, "log-run (30KB)"));
    assert!(!is_match(&LOG_RUN, "log-run-ish"));
    assert_eq!(
        filed_in("x\nwrote /a.json (folded)\nalready filed /b.json\r\n"),
        "/b.json"
    );
    assert_eq!(filed_in("craft-log-run FAILED: no"), "");
}

#[test]
fn an_agent_with_no_timestamp_starts_at_its_transcript_mtime() {
    let d = tempfile::tempdir().unwrap();
    std::fs::write(d.path().join("agent-a.jsonl"), "{}\n").unwrap();
    let a = read_agent(d.path(), "agent-a.jsonl");
    assert!(a.start > 1.7e12, "{a:?}");
    assert_eq!((a.record.as_str(), a.instance.as_str()), ("", ""));
}
