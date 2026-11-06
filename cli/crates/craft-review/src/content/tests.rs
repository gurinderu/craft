use super::*;
use serde_json::json;

#[test]
fn a_placeholder_is_replaced_and_the_final_newline_dropped() {
    let out = render(
        "a {{x}} b {{y2}}\n",
        &vars([("x", "1".into()), ("y2", "2".into())]),
    );
    assert_eq!(out.unwrap(), "a 1 b 2");
}

#[test]
fn only_one_final_newline_is_dropped() {
    assert_eq!(render("a\n\n", &Vars::new()).unwrap(), "a\n");
    assert_eq!(content_text("a"), "a");
}

#[test]
fn a_placeholder_with_no_value_is_an_error() {
    let err = render("hi {{name}}", &Vars::new()).unwrap_err();
    assert_eq!(err, ContentError::MissingValue("name".into()));
    assert_eq!(
        err.to_string(),
        "template placeholder {{name}} has no value"
    );
}

#[test]
fn a_value_is_never_itself_rendered() {
    let out = render("{{a}}", &vars([("a", "{{b}}".into())])).unwrap();
    assert_eq!(out, "{{b}}");
}

#[test]
fn what_is_not_a_placeholder_stays_as_written() {
    let v = vars([("a", "A".into())]);
    assert_eq!(render("{{{a}}}", &v).unwrap(), "{A}");
    assert_eq!(
        render("{{1a}} {{ a }} {{a", &v).unwrap(),
        "{{1a}} {{ a }} {{a"
    );
    assert_eq!(render("${X} {a}", &v).unwrap(), "${X} {a}");
}

#[test]
fn a_ref_is_inlined_and_resolved_in_turn() {
    let refs = BTreeMap::from([
        (
            "a.json".to_owned(),
            json!({"type": "array", "items": {"$ref": "b.json"}}),
        ),
        ("b.json".to_owned(), json!({"type": "string"})),
    ]);
    let got = resolve_refs(&json!({"properties": {"x": {"$ref": "a.json"}}}), &refs).unwrap();
    assert_eq!(
        got,
        json!({"properties": {"x": {"type": "array", "items": {"type": "string"}}}})
    );
}

#[test]
fn an_unknown_ref_and_a_cycle_are_errors() {
    let refs = BTreeMap::from([("c.json".to_owned(), json!({"$ref": "c.json"}))]);
    assert_eq!(
        resolve_refs(&json!({"$ref": "z.json"}), &refs).unwrap_err(),
        ContentError::UnknownRef("z.json".into())
    );
    assert!(matches!(
        resolve_refs(&json!({"$ref": "c.json"}), &refs),
        Err(ContentError::TooDeep(_))
    ));
}

#[test]
fn the_findings_schema_carries_the_finding_item_inline() {
    let s = schema("findings").unwrap();
    let item = &s["properties"]["findings"]["items"];
    assert_eq!(item["type"], json!("object"));
    assert!(
        item["required"]
            .as_array()
            .unwrap()
            .contains(&json!("whereChecked"))
    );
    assert!(!s.to_string().contains("$ref"));
}

#[test]
fn an_unknown_content_file_is_an_error() {
    assert_eq!(
        raw("prompts/nope.md").unwrap_err(),
        ContentError::UnknownFile("prompts/nope.md".into())
    );
}
