//! Answers read from the files the tasks' agents wrote, with no host copying them.

mod common;

use common::{answers, finding, fixture, ids, opts, prompt_of, verdict, write_answer};
use craft_review::status;
use craft_review::step;
use serde_json::json;

#[test]
fn a_full_loop_reads_every_answer_from_its_file() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    let s = step::start(&opts(repo.path(), out.path())).unwrap();
    let lens = json!({"lens": "intent", "findings": [finding("High", 1), finding("Low", 1)]});
    write_answer(&s, "lens-intent", &lens.to_string());
    let s = step::submit(&run, None).unwrap();
    assert_eq!(ids(&s), ["verify-0", "verify-batch-0"]);
    assert!(prompt_of(&s["tasks"][1]).contains("--- FINDING 0 ---"));
    write_answer(&s, "verify-0", &verdict(false).to_string());
    let batch = json!({"verdicts": [{"index": 0, "refuted": true, "citedLineMatches": true, "reachable": true, "premiseSupported": true, "reason": "no"}]});
    write_answer(&s, "verify-batch-0", &batch.to_string());
    let s = step::submit(&run, None).unwrap();
    assert_eq!(
        (s["done"].clone(), s["verdict"].clone()),
        (json!(true), json!("Block"))
    );
    for id in ["lens-intent", "verify-0", "verify-batch-0"] {
        assert!(
            run.join(format!("answers/{id}.json")).is_file(),
            "{id}'s accepted answer is kept"
        );
    }
    let st = status::status(&run).unwrap();
    assert_eq!(
        (st["findings"].clone(), st["tiers"]["refuted"].clone()),
        (json!(2), json!(1))
    );
}

#[test]
fn a_missing_an_unparsable_and_an_invalid_file_are_each_asked_again_then_fail() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    step::start(&opts(repo.path(), out.path())).unwrap();

    let s = step::submit(&run, None).unwrap();
    assert_eq!(ids(&s), ["lens-intent"]);
    let prompt = prompt_of(&s["tasks"][0]);
    assert!(
        prompt.contains("Your previous answer was invalid: no answer file was written at"),
        "the prompt file is rewritten with the note: {prompt}"
    );

    write_answer(&s, "lens-intent", "{\"lens\": \"intent\", \"findings\": [");
    let s = step::submit(&run, None).unwrap();
    assert!(prompt_of(&s["tasks"][0]).contains("is not JSON"));
    assert!(
        !run.join("answers/lens-intent.json").exists()
            && run.join("answers/lens-intent.rejected-1.json").is_file(),
        "a refused file is set aside, so a retry that writes nothing is not read as it"
    );

    write_answer(&s, "lens-intent", "{\"lens\": \"intent\"}");
    let s = step::submit(&run, None).unwrap();
    assert_eq!(
        (s["done"].clone(), s["verdict"].clone()),
        (json!(true), json!("INCOMPLETE"))
    );
    let st = status::status(&run).unwrap();
    assert_eq!(st["tasks"][0]["state"], json!("failed"));
    assert!(
        st["tasks"][0]["error"]
            .as_str()
            .unwrap()
            .contains("does not match the schema")
    );
}

#[test]
fn answers_given_by_the_host_override_the_files() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    let s = step::start(&opts(repo.path(), out.path())).unwrap();
    write_answer(&s, "lens-intent", "not json");
    let empty = json!({"lens": "intent", "findings": []});
    let s = step::submit(&run, Some(&answers(json!({"lens-intent": empty})))).unwrap();
    assert_eq!(s["verdict"], json!("Approve"));
}
