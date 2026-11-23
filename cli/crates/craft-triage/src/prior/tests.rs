use super::*;

fn ledger(text: &str) -> HashMap<String, Row> {
    let entries = craft_store::js::parse(text).unwrap();
    ledger_by_id(entries.as_arr().unwrap())
}

#[test]
fn the_prior_ledger_is_read_as_far_as_its_entries_are_objects() {
    let by = ledger(
        r#"[{"stable_id":"a","verdict":"reject","reason":"no"},"not an object",null,
            {"stable_id":7,"sifted":true},{"verdict":null},{"stable_id":1.0,"reason":[1,2]}]"#,
    );
    assert_eq!(by.len(), 4);
    assert_eq!(by["a"].text("reason"), "no");
    assert_eq!(by["a"].0.get("sifted"), Some(&Js::Bool(false)));
    assert_eq!(by["7"].0.get("sifted"), Some(&Js::Bool(true)));
    assert_eq!(by["7"].verdict(), "");
    assert_eq!(by["undefined"].verdict(), "");
    assert_eq!(by["1"].text("reason"), "1,2");
}

#[test]
fn a_later_entry_under_one_id_replaces_an_earlier_one() {
    let by = ledger(
        r#"[{"stable_id":"a","verdict":"accept","reason":"first"},{"stable_id":"a","verdict":"reject","reason":"last"}]"#,
    );
    assert_eq!(
        settled_prior(&by, "a").map(|e| e.text("reason")),
        Some("last")
    );
}

#[test]
fn only_a_judged_reject_defer_or_needs_decision_is_settled() {
    let by = ledger(
        r#"[{"stable_id":"r","verdict":"reject","reason":"no"},
            {"stable_id":"a","verdict":"accept","reason":"ok"},
            {"stable_id":"c","verdict":"conflict","reason":"x"},
            {"stable_id":"u","verdict":"needs-decision","reason":"carried: NOT JUDGED — died"},
            {"stable_id":"s","verdict":"defer","reason":"later","sifted":true},
            {"stable_id":"m","verdict":"reject","reason":"SIFTED BEFORE VALIDATION — y"}]"#,
    );
    assert_eq!(
        settled_prior(&by, "r").map(|e| e.text("reason")),
        Some("no")
    );
    for id in ["a", "c", "u", "s", "m", "missing"] {
        assert!(settled_prior(&by, id).is_none(), "{id}");
    }
}
