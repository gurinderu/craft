use super::*;

fn j(s: &str) -> Json {
    serde_json::from_str(s).unwrap()
}

fn row(s: &str) -> Row {
    Row(j(s).as_object().unwrap().clone())
}

fn rows(s: &str) -> Vec<Json> {
    j(s).as_array().unwrap().to_vec()
}

fn text(v: &[Json]) -> String {
    serde_json::to_string(v).unwrap()
}

const REPEAT: &str = r#"{"stable_id":"r","verdict":"reject","sifted":true,"repeat_of":"a","reason":"SIFTED BEFORE VALIDATION — repeats"}"#;

#[test]
fn with_nothing_pinned_the_plan_ledger_stands() {
    let planned = rows(r#"[{"stable_id":"a","verdict":"accept","reason":"ok"},null]"#);
    let judged = row(r#"{"stable_id":"a","verdict":"accept","reason":"ok"}"#);
    assert_eq!(pinned_ledger(&planned, &[], &[judged]), planned);
}

#[test]
fn a_paraphrased_row_is_restored_in_place_a_dropped_one_appended_a_kept_one_untouched() {
    let dead = Row::unjudged("d");
    let planned = rows(
        r#"[{"reason":"looked fine","stable_id":"d","verdict":"accept"},
            {"stable_id":"k","verdict":"needs-decision","reason":"x NOT JUDGED y"},
            "not a row",
            {"stable_id":"a","verdict":"accept","reason":"ok"}]"#,
    );
    let validations = [
        dead.clone(),
        Row::unjudged("k"),
        row(r#"{"stable_id":"a","verdict":"accept","reason":"ok"}"#),
    ];
    let got = pinned_ledger(&planned, &[row(REPEAT)], &validations);
    let dead_reason = dead.text("reason");
    assert_eq!(
        text(&got),
        format!(
            r#"[{{"reason":"{dead_reason}","stable_id":"d","verdict":"needs-decision"}},{{"stable_id":"k","verdict":"needs-decision","reason":"x NOT JUDGED y"}},"not a row",{{"stable_id":"a","verdict":"accept","reason":"ok"}},{{"stable_id":"r","verdict":"reject","reason":"SIFTED BEFORE VALIDATION — repeats","sifted":true,"repeat_of":"a"}}]"#
        )
    );
}

#[test]
fn a_sifted_row_missing_either_field_is_restored() {
    for planned in [
        r#"[{"stable_id":"r","verdict":"reject","reason":"SIFTED BEFORE VALIDATION — repeats","repeat_of":"a"}]"#,
        r#"[{"stable_id":"r","verdict":"reject","reason":"SIFTED BEFORE VALIDATION — repeats","sifted":true,"repeat_of":"b"}]"#,
    ] {
        let got = pinned_ledger(&rows(planned), &[row(REPEAT)], &[]);
        assert_eq!(got[0].at("sifted"), &Json::Bool(true), "{planned}");
        assert_eq!(got[0].at("repeat_of").as_str(), Some("a"), "{planned}");
    }
    let kept = format!("[{REPEAT}]");
    assert_eq!(
        text(&pinned_ledger(&rows(&kept), &[row(REPEAT)], &[])),
        kept
    );
}

#[test]
fn a_class_one_row_carries_the_issue_action_at_its_end() {
    let issue =
        row(r#"{"stable_id":"i","verdict":"defer","reason":"not this PR's","action":"issue"}"#);
    let got = with_issue_actions(
        rows(r#"[{"stable_id":"i","verdict":"defer","reason":"x"},{"stable_id":"o"},7]"#),
        std::slice::from_ref(&issue),
    );
    assert_eq!(
        text(&got),
        r#"[{"stable_id":"i","verdict":"defer","reason":"x","action":"issue"},{"stable_id":"o"},7]"#
    );
    let fallback = final_ledger(None, &[row(REPEAT)], &[issue]);
    assert_eq!(fallback.len(), 2);
    assert_eq!(fallback[1].at("action").as_str(), Some("issue"));
}
