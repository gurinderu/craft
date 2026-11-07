//! Answers read from the files the tasks' agents wrote, with no host copying them.

mod common;

use common::{
    answers, finding, fixture, ids, lens, opts, prompt_of, small_run, verdict, write_answer,
};
use craft_review::status;
use craft_review::step;
use serde_json::{Value, json};

#[test]
fn a_full_loop_reads_every_answer_from_its_file() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    let (run2, s) = small_run(repo.path(), out.path());
    assert_eq!(run2, run);
    let mut medium = finding("Medium", 2);
    medium["title"] = json!("another");
    write_answer(
        &s,
        "lens-errors-r1",
        &lens("errors", &[finding("High", 1), medium]).to_string(),
    );
    write_answer(&s, "lens-intent-r1", &lens("intent", &[]).to_string());
    write_answer(&s, "lens-tests-r1", &lens("tests", &[]).to_string());
    let s = step::submit(&run, None).unwrap();
    assert_eq!(ids(&s), ["dedup-rust"]);
    write_answer(&s, "dedup-rust", r#"{"groups": []}"#);
    let s = step::submit(&run, None).unwrap();
    assert_eq!(ids(&s), ["verify-0-v0", "verify-0-v1", "verify-batch-0"]);
    assert!(prompt_of(&s["tasks"][2]).contains("--- FINDING 0 ---"));
    write_answer(&s, "verify-0-v0", &verdict(false).to_string());
    write_answer(&s, "verify-0-v1", &verdict(false).to_string());
    let batch = json!({"verdicts": [{"index": 0, "refuted": true, "citedLineMatches": true, "reachable": true, "premiseSupported": true, "reason": "no"}]});
    write_answer(&s, "verify-batch-0", &batch.to_string());
    let s = step::submit(&run, None).unwrap();
    assert_eq!(
        (s["done"].clone(), s["verdict"].clone()),
        (json!(true), json!("Block"))
    );
    for id in [
        "lens-errors-r1",
        "dedup-rust",
        "verify-0-v0",
        "verify-0-v1",
        "verify-batch-0",
    ] {
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
    assert_eq!(ids(&s), ["scout-rust"]);
    let prompt = prompt_of(&s["tasks"][0]);
    assert!(
        prompt.contains("Your previous answer was invalid: no answer file was written at"),
        "the prompt file is rewritten with the note: {prompt}"
    );

    write_answer(&s, "scout-rust", "{\"sizeBucket\": ");
    let s = step::submit(&run, None).unwrap();
    assert!(prompt_of(&s["tasks"][0]).contains("is not JSON"));
    assert!(
        !run.join("answers/scout-rust.json").exists()
            && run.join("answers/scout-rust.rejected-1.json").is_file(),
        "a refused file is set aside, so a retry that writes nothing is not read as it"
    );

    write_answer(&s, "scout-rust", "{\"sizeBucket\": \"small\"}");
    let s = step::submit(&run, None).unwrap();
    assert!(
        ids(&s).len() > 3,
        "a failed scout gives the conservative plan: {s}"
    );
    let st = status::status(&run).unwrap();
    assert!(
        st["notRun"][0]
            .as_str()
            .unwrap()
            .contains("does not match the schema"),
        "{st}"
    );
}

#[test]
fn answers_given_by_the_host_override_the_files() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    let (_, s) = small_run(repo.path(), out.path());
    write_answer(&s, "lens-errors-r1", "not json");
    let empty = json!({
        "lens-errors-r1": lens("errors", &[]), "lens-intent-r1": lens("intent", &[]), "lens-tests-r1": lens("tests", &[]),
    });
    let s = step::submit(&run, Some(&answers(empty))).unwrap();
    assert_eq!(s["verdict"], json!("Approve"));
}

/// The `agentType` each task of step `s` names, `None` where it names none.
fn agent_types(s: &Value) -> Vec<Option<&str>> {
    s["tasks"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|t| t.get("agentType").and_then(Value::as_str))
        .collect()
}

#[test]
fn only_the_lens_tasks_name_the_profile_agent() {
    let repo = fixture(true);
    let scouted = tempfile::tempdir().unwrap();
    let scout = step::start(&opts(repo.path(), scouted.path())).unwrap();
    assert_eq!(
        agent_types(&scout),
        [None],
        "the scout runs on the default agent"
    );

    let out = tempfile::tempdir().unwrap();
    let (run, s) = small_run(repo.path(), out.path());
    assert_eq!(
        agent_types(&s),
        [Some("rust-reviewer"); 3],
        "every lens runs on the profile's lens agent, named without a host prefix"
    );
    let mut medium = finding("Medium", 2);
    medium["title"] = json!("another");
    let round1 = json!({
        "lens-errors-r1": lens("errors", &[finding("High", 1), medium]),
        "lens-intent-r1": lens("intent", &[]),
        "lens-tests-r1": lens("tests", &[]),
    });
    let s = step::submit(&run, Some(&answers(round1))).unwrap();
    assert_eq!(ids(&s), ["dedup-rust"]);
    assert_eq!(
        agent_types(&s),
        [None],
        "the dedup runs on the default agent"
    );
    let dedup = json!({"dedup-rust": {"groups": []}});
    let s = step::submit(&run, Some(&answers(dedup))).unwrap();
    assert!(
        !ids(&s).is_empty() && ids(&s).iter().all(|id| id.starts_with("verify")),
        "{s}"
    );
    assert!(
        agent_types(&s).iter().all(Option::is_none),
        "the verifiers run on the default agent: {s}"
    );
}
