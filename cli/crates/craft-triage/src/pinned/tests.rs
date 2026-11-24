use super::*;

fn j(s: &str) -> Js {
    craft_store::js::parse(s).unwrap()
}

fn row(s: &str) -> Row {
    Row(j(s).as_obj().unwrap().clone())
}

fn rows(s: &str) -> Vec<Js> {
    j(s).as_arr().unwrap().to_vec()
}

fn text(v: &[Js]) -> String {
    Js::Arr(v.to_vec()).compact()
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
    let dead = Row::unjudged(&"d".into());
    let planned = rows(
        r#"[{"reason":"looked fine","stable_id":"d","verdict":"accept"},
            {"stable_id":"k","verdict":"needs-decision","reason":"x NOT JUDGED y"},
            "not a row",
            {"stable_id":"a","verdict":"accept","reason":"ok"}]"#,
    );
    let validations = [
        dead.clone(),
        Row::unjudged(&"k".into()),
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
        assert_eq!(
            crate::field::at(&got[0], "sifted"),
            &Js::Bool(true),
            "{planned}"
        );
        assert_eq!(
            crate::field::at(&got[0], "repeat_of").as_str(),
            Some("a"),
            "{planned}"
        );
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
    assert_eq!(
        crate::field::at(&fallback[1], "action").as_str(),
        Some("issue")
    );
}

#[test]
fn a_row_keeping_the_pinned_mark_but_changing_the_verdict_is_restored() {
    let unjudged = Row::unjudged(&"d".into());
    let reason = unjudged.text("reason").into_owned();
    let planned = rows(&format!(
        r#"[{{"stable_id":"d","verdict":"reject","reason":"{reason}"}}]"#
    ));
    let got = pinned_ledger(&planned, &[], &[unjudged]);
    assert_eq!(
        crate::field::at(&got[0], "verdict").as_str(),
        Some("needs-decision")
    );
    let sifted = REPEAT.replace(r#""verdict":"reject""#, r#""verdict":"accept""#);
    let got = pinned_ledger(&rows(&format!("[{sifted}]")), &[row(REPEAT)], &[]);
    assert_eq!(
        crate::field::at(&got[0], "verdict").as_str(),
        Some("reject")
    );
}

#[test]
fn a_verdict_its_noise_class_settled_is_restored_and_a_dropped_one_appended() {
    let five = row(
        r#"{"stable_id":"f","verdict":"needs-decision","reason":"not decidable","noise_class":5}"#,
    );
    let one = row(
        r#"{"stable_id":"o","verdict":"needs-decision","reason":"claimed not this PR's, but x","noise_class":1}"#,
    );
    let other = row(r#"{"stable_id":"x","verdict":"needs-decision","reason":"r","noise_class":2}"#);
    let planned = rows(
        r#"[{"stable_id":"o","verdict":"accept","reason":"fine"},
            {"stable_id":"x","verdict":"accept","reason":"fine"}]"#,
    );
    let got = pinned_ledger(&planned, &[], &[five, one, other]);
    assert_eq!(
        text(&got),
        r#"[{"stable_id":"o","verdict":"needs-decision","reason":"claimed not this PR's, but x"},{"stable_id":"x","verdict":"accept","reason":"fine"},{"stable_id":"f","verdict":"needs-decision","reason":"not decidable"}]"#
    );
    // Its verdict kept, a paraphrased reason stands: the class row carries no mark.
    let kept = rows(r#"[{"stable_id":"f","verdict":"needs-decision","reason":"a human decides"}]"#);
    let five = row(
        r#"{"stable_id":"f","verdict":"needs-decision","reason":"not decidable","noise_class":5}"#,
    );
    assert_eq!(pinned_ledger(&kept, &[], &[five]), kept);
}

#[test]
fn a_class_one_verdict_the_class_left_alone_is_not_pinned() {
    let left = row(r#"{"stable_id":"r","verdict":"reject","reason":"r","noise_class":1}"#);
    let planned = rows(r#"[{"stable_id":"r","verdict":"accept","reason":"fine"}]"#);
    assert_eq!(pinned_ledger(&planned, &[], &[left]), planned);
}
