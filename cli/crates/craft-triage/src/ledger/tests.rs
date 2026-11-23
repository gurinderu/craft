use craft_store::js::parse;

use super::*;

fn text(r: &Row) -> String {
    Js::from(r.clone()).compact()
}

#[test]
fn the_fields_read_are_the_ones_the_validation_schema_requires() {
    let file = format!(
        "{}/../../../content/schemas/triage-validation.schema.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let schema = parse(&std::fs::read_to_string(file).unwrap()).unwrap();
    let mut required: Vec<&str> = field::at(&schema, "required")
        .as_arr()
        .unwrap()
        .iter()
        .map(|k| k.as_str().unwrap())
        .collect();
    let mut read: Vec<&str> = TEXT_FIELDS.iter().copied().chain([NUMBER_FIELD]).collect();
    required.sort_unstable();
    read.sort_unstable();
    assert_eq!(read, required);
    let kind = field::at(
        field::at(field::at(&schema, "properties"), NUMBER_FIELD),
        "type",
    );
    assert_eq!(kind.as_str(), Some("integer"));
}

#[test]
fn a_carried_and_an_unjudged_verdict_say_so_in_the_engines_order() {
    let prior = Row(
        parse(r#"{"stable_id":"r","verdict":"defer","reason":"later"}"#)
            .unwrap()
            .as_obj()
            .unwrap()
            .clone(),
    );
    assert_eq!(
        text(&Row::carried(&prior)),
        r#"{"stable_id":"r","verdict":"defer","reason":"carried from prior run: later","fix_pointer":"","premise_checked":"(carried from prior run — not re-checked)"}"#
    );
    let u = Row::unjudged(&"x".into());
    assert_eq!(u.verdict(), "needs-decision");
    assert!(
        text(&u)
            .starts_with(r#"{"stable_id":"x","verdict":"needs-decision","reason":"NOT JUDGED — "#)
    );
}

#[test]
fn a_validator_answer_is_read_as_it_came_or_refused() {
    let full = r#"{"verdict":"accept","stable_id":"a","reason":"r","fix_pointer":"","premise_checked":"","noise_class":6,"severity":"Low"}"#;
    let v = Row::validation(&parse(full).unwrap()).unwrap();
    assert_eq!(text(&v), full);
    let as_float = full.replace(r#""noise_class":6"#, r#""noise_class":6.0"#);
    assert_eq!(
        text(&Row::validation(&parse(&as_float).unwrap()).unwrap()),
        full
    );
    for bad in [
        r#"{"verdict":"accept"}"#.to_owned(),
        full.replace(r#""noise_class":6"#, r#""noise_class":"6""#),
        full.replace(r#""noise_class":6"#, r#""noise_class":1.5"#),
        "[]".to_owned(),
    ] {
        let read = Row::validation(&parse(&bad).unwrap());
        assert!(matches!(read, Err(TriageError::Answer { .. })), "{bad}");
    }
}

#[test]
fn a_validator_answer_with_an_unpaired_surrogate_is_read_with_it() {
    let text = r#"{"stable_id":"a\ud800","verdict":"reject","reason":"r\udc00","fix_pointer":"","premise_checked":"","noise_class":0,"severity":"Low"}"#;
    let v = Row::validation(&parse(text).unwrap()).unwrap();
    assert_eq!(v.id(), JsString::from_utf16(vec![0x61, 0xd800]));
    assert_eq!(
        v.0.text_units("reason"),
        JsString::from_utf16(vec![0x72, 0xdc00])
    );
}
