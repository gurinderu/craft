use super::*;

fn text(r: &Row) -> String {
    serde_json::to_string(&Json::from(r.clone())).unwrap()
}

#[test]
fn a_carried_and_an_unjudged_verdict_say_so_in_the_engines_order() {
    let prior = Row(Obj::new()
        .with("stable_id", "r")
        .with("verdict", "defer")
        .with("reason", "later"));
    assert_eq!(
        text(&Row::carried(&prior)),
        r#"{"stable_id":"r","verdict":"defer","reason":"carried from prior run: later","fix_pointer":"","premise_checked":"(carried from prior run — not re-checked)"}"#
    );
    let u = Row::unjudged("x");
    assert_eq!(u.verdict(), "needs-decision");
    assert!(u.text("reason").starts_with("NOT JUDGED — "));
    assert!(
        text(&u).starts_with(r#"{"stable_id":"x","verdict":"needs-decision","reason":"NOT JUDGED"#)
    );
}

#[test]
fn a_validator_answer_is_read_as_it_came_or_refused() {
    let full = r#"{"verdict":"accept","stable_id":"a","reason":"r","fix_pointer":"","premise_checked":"","noise_class":6,"severity":"Low"}"#;
    let v = Row::validation(&serde_json::from_str(full).unwrap()).unwrap();
    assert_eq!(text(&v), full);
    for bad in [
        r#"{"verdict":"accept"}"#,
        &full.replace(r#""noise_class":6"#, r#""noise_class":"6""#),
        "[]",
    ] {
        let answer = serde_json::from_str(bad).unwrap();
        assert!(
            matches!(Row::validation(&answer), Err(TriageError::Answer { .. })),
            "{bad}"
        );
    }
}
