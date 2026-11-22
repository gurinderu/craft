//! The request held to what the JavaScript `finding-post` built, frozen in
//! `content/parity/finding-post-cases.json` when it was ported here.

use serde_json::{Value, json};

use super::request::{chosen, is_sha};
use crate::publish::gh::send::request;

const CASES: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../content/parity/finding-post-cases.json"
));

#[test]
fn every_request_is_the_one_the_javascript_poster_built() {
    let file: Value = serde_json::from_str(CASES).unwrap();
    let findings = file["findings"].as_array().unwrap();
    let cases = file["cases"].as_array().unwrap();
    assert!(cases.len() > 25, "the frozen cases are all there");
    for c in cases {
        let (n, commit) = (c["n"].as_f64().unwrap(), c["commit"].as_str().unwrap());
        let question = c["kind"] == json!("question");
        let got = match chosen(findings, n, question, c["linesJudged"] == json!(true)) {
            Err(e) => json!({"error": e}),
            Ok(_) if !is_sha(commit) => {
                json!({"error": format!("--commit must be the PR head sha, got {}", Value::from(commit))})
            }
            Ok(ch) => request(&ch.file, ch.line, commit, &ch.body),
        };
        assert_eq!(got, c["expected"], "{}", c["name"]);
    }
}
