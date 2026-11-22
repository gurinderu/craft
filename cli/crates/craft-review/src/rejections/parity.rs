//! The reader held to what `integrations/shared/pr-rejections.mjs` printed, frozen in
//! `content/parity/pr-rejections-cases.json` when it was ported here.

use serde_json::{Value, json};

const CASES: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../content/parity/pr-rejections-cases.json"
));

#[test]
fn every_answer_reads_as_the_javascript_reader_read_it() {
    let file: Value = serde_json::from_str(CASES).unwrap();
    let cases = file["cases"].as_array().unwrap();
    assert!(cases.len() > 50, "the frozen cases are all there");
    for c in cases {
        let got = match super::from_answer(&c["answer"]) {
            Ok(r) => serde_json::to_value(&r).unwrap(),
            Err(e) => json!({"error": e.to_string()}),
        };
        assert_eq!(got, c["expected"], "{}", c["name"]);
    }
}

#[test]
fn the_printed_text_keeps_the_javascript_readers_order() {
    let file: Value = serde_json::from_str(CASES).unwrap();
    let c = file["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == json!("lens, tool rule and line carried"))
        .unwrap();
    let printed = serde_json::to_string_pretty(&super::from_answer(&c["answer"]).unwrap()).unwrap();
    // JSON.stringify(r, null, 2): two-space indent, the record's keys in the order it built them.
    assert!(
        printed.starts_with("{\n  \"decisions\": [\n    {\n      \"id\": \"decision-"),
        "{printed}"
    );
    let keys = [
        "id",
        "kind",
        "title",
        "body",
        "scope",
        "status",
        "date",
        "author",
        "decidedBy",
        "commit",
        "links",
        "line",
        "lens",
        "toolRule",
        "skipped",
    ];
    let at: Vec<usize> = keys
        .iter()
        .map(|k| printed.find(&format!("\"{k}\":")).unwrap())
        .collect();
    assert!(at.is_sorted(), "{printed}");
}
