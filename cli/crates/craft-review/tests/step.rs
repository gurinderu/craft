//! The step protocol end to end over a fixture repository with a real git diff: the scout, the
//! lens rounds, the dedup, the verifiers, the report.

mod common;

use common::{
    answers, assert_contains_all, fixture, ids, lens, opts, prompt_of, scout, small_run, submit,
    titled, verdict,
};
use craft_review::Error;
use craft_review::git::GitError;
use craft_review::status;
use craft_review::step::{self, StepError};
use serde_json::{Map, Value, json};

#[test]
fn start_renders_the_scout_over_the_diff() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let s = step::start(&opts(repo.path(), out.path())).unwrap();
    assert_eq!(s["done"], json!(false));
    let task = &s["tasks"][0];
    let run = out.path().join("run");
    let at = |p: &str| json!(run.join(p).display().to_string());
    assert_eq!(
        task,
        &json!({
            "id": "scout-rust", "label": "scout:rust", "model": "haiku",
            "promptFile": at("tasks/scout-rust.md"),
            "schemaFile": at("tasks/scout-rust.schema.json"),
            "answerFile": at("answers/scout-rust.json"), "kind": "scout",
        }),
        "the task names its files and what it is for, and carries no prompt or schema text"
    );
    assert_eq!(
        s["phase"],
        json!("scout"),
        "the step names the phase its tasks run in"
    );
    let prompt = prompt_of(task);
    for want in [
        "You are scouting a Rust diff",
        "git diff --stat 'origin/main'...HEAD -- '*.rs'",
        r#"choose from ["safety","errors","concurrency","performance","api-idioms","api-boundary","reconciler","failure-windows","compat","maintainability","tests","intent","invariants"]"#,
        r#"EXCEPT ["failure-windows"]"#,
        "Decide what is \"in play\" from the diff",
        "Return repo-relative paths, at most 5",
    ] {
        assert!(prompt.contains(want), "{want}: {prompt}");
    }
    assert!(
        !prompt.contains("{{"),
        "an unrendered placeholder: {prompt}"
    );
    let schema: Value = serde_json::from_str(
        &std::fs::read_to_string(run.join("tasks/scout-rust.schema.json")).unwrap(),
    )
    .unwrap();
    assert!(
        schema["required"]
            .as_array()
            .unwrap()
            .contains(&json!("sizeBucket"))
    );
    assert_eq!(status::status(&run).unwrap()["phase"], json!("scout"));
    let again = step::start(&opts(repo.path(), out.path())).unwrap_err();
    assert!(
        matches!(again, Error::Step(StepError::RunExists(_))),
        "{again}"
    );
    assert!(
        again.to_string().ends_with("holds a run already"),
        "{again}"
    );
}

/// The three lens answers of a small run's round 1.
fn round1(errors: &[Value]) -> Value {
    json!({
        "lens-rust-errors-r1": lens("errors", errors),
        "lens-rust-intent-r1": lens("intent", &[]),
        "lens-rust-tests-r1": lens("tests", &[]),
    })
}

/// Round 1 finds four (a High pair worded twice at one spot), round 2 only a known place: the
/// pool goes to the dedup.
#[expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "a step of the test below, failing loudly like it"
)]
fn lens_rounds(run: &std::path::Path) {
    let run = run.to_path_buf();
    // Round 1: two lenses report one defect in other words at one spot, and one more each.
    let s = submit(
        &run,
        json!({
            "lens-rust-errors-r1": lens("errors", &[titled("High", 1, "f returns 1 where 0 is claimed"), titled("Medium", 1, "no doc")]),
            "lens-rust-intent-r1": lens("intent", &[titled("High", 1, "f returns 1, where 0 is claimed!"), titled("Low", 1, "naming")]),
            "lens-rust-tests-r1": lens("tests", &[]),
        }),
    );
    assert_eq!(
        ids(&s),
        [
            "lens-rust-errors-r2",
            "lens-rust-intent-r2",
            "lens-rust-tests-r2"
        ]
    );
    let p = prompt_of(&s["tasks"][0]);
    assert!(
        p.contains("src/lib.rs:1 f returns 1 where 0 is claimed\nsrc/lib.rs:1 f returns 1, where 0 is claimed!\nsrc/lib.rs:1 no doc\nsrc/lib.rs:1 naming"),
        "the pool, worst first: {p}"
    );
    assert_eq!(
        status::status(&run).unwrap()["phase"],
        json!("lenses round 2")
    );

    // Round 2 re-surfaces a known place only: dry, so the pool goes to the dedup.
    let s = submit(
        &run,
        json!({
            "lens-rust-errors-r2": lens("errors", &[titled("Medium", 1, "No  DOC")]),
            "lens-rust-intent-r2": lens("intent", &[]),
            "lens-rust-tests-r2": lens("tests", &[]),
        }),
    );
    assert_eq!(ids(&s), ["dedup-rust"]);
    let p = prompt_of(&s["tasks"][0]);
    assert!(
        p.contains("2. src/lib.rs:1 [High] (intent) f returns 1, where 0 is claimed! — wrong"),
        "{p}"
    );
    let st = status::status(&run).unwrap();
    assert_eq!(
        (st["phase"].clone(), st["pool"].clone()),
        (json!("dedup"), json!(4))
    );
    assert_eq!(
        st["rounds"][1],
        json!({"round": 2, "agents": 3, "returned": 3, "newFindings": 0})
    );
}

#[test]
fn a_full_run_goes_scout_lenses_two_rounds_dedup_verify_done() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    step::start(&opts(repo.path(), out.path())).unwrap();
    let s = submit(
        &run,
        json!({"scout-rust": scout("medium", &["errors", "bogus"])}),
    );
    assert_eq!(
        ids(&s),
        [
            "lens-rust-errors-r1",
            "lens-rust-intent-r1",
            "lens-rust-tests-r1"
        ]
    );
    assert_eq!(s["tasks"][0]["label"], json!("lens:rust:errors r1"));
    assert_contains_all(
        &prompt_of(&s["tasks"][1]),
        &[
            "You are the **intent** review lens for a Rust diff",
            "INTENT (what the change should do): add f, which never fails",
            "HOT FILES (scrutinize harder): src/lib.rs",
            "REPO RULES `AGENTS.md`",
            "ALREADY-FOUND (do not re-report these PLACES",
            "none yet",
            "feat: add f, which never fails",
            "--merge-base 'origin/main' -- '*.rs'",
        ],
    );
    let st = status::status(&run).unwrap();
    assert_eq!(
        (st["phase"].clone(), st["round"].clone()),
        (json!("lenses round 1"), json!(1))
    );
    assert_eq!(st["profiles"][0]["plan"]["maxRounds"], json!(2));

    lens_rounds(&run);

    // The model groups nothing; the same-spot pass merges the High pair.
    let s = submit(&run, json!({"dedup-rust": {"groups": []}}));
    assert_eq!(ids(&s), ["verify-2-v0", "verify-2-v1", "verify-batch-0"]);
    assert_eq!(status::status(&run).unwrap()["phase"], json!("verify"));
    assert_eq!(
        (&s["phase"], &s["tasks"][0]["kind"], &s["tasks"][2]["kind"]),
        (&json!("verify"), &json!("verify"), &json!("verifyBatch"))
    );
    let s = submit(
        &run,
        json!({
            "verify-2-v0": verdict(false),
            "verify-2-v1": verdict(false),
            "verify-batch-0": {"verdicts": [{"index": 0, "refuted": true, "citedLineMatches": true, "reachable": true, "premiseSupported": true, "behaviourIntended": false, "harmSupported": false, "confirmedHarmLevel": null, "reason": "documented"}]},
        }),
    );
    assert_eq!(
        (s["done"].clone(), s["verdict"].clone()),
        (json!(true), json!("Block"))
    );
    let report = std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap();
    assert_contains_all(
        &report,
        &[
            "Plan: medium diff, full review, at most 2 round(s). Lenses planned: errors, intent, tests; ran: errors, intent, tests.",
            "- Round 1: 3 lens(es) dispatched, 3 returned, 4 new finding(s).",
            "- Round 2: 3 lens(es) dispatched, 3 returned, 0 new finding(s).",
            "## Confirmed findings\n\n- **High** `src/lib.rs:1` — f returns 1 where 0 is claimed (errors, intent)",
            "(same defect also reported by: intent)",
            "## Unverified findings\n\n- **Low** `src/lib.rs:1` — naming (intent)",
            "## Refuted findings\n\n- **Medium** `src/lib.rs:1` — no doc (errors)",
            "3 finding(s) reported: 1 confirmed, 0 suspected, 1 refuted, 1 unverified.",
            "dedup before verification: 4 → 3 (1 cross-lens duplicate(s) merged)",
        ],
    );
    let mut reported: Vec<Value> = s["findings"].as_array().unwrap().clone();
    reported.sort_by_key(|f| f["tier"].as_str().unwrap().to_owned());
    assert_eq!(
        reported,
        [
            json!({"severity": "High", "file": "src/lib.rs", "line": 1, "title": "f returns 1 where 0 is claimed", "ruleId": "", "tier": "confirmed"}),
            json!({"severity": "Low", "file": "src/lib.rs", "line": 1, "title": "naming", "ruleId": "", "tier": "unverified"}),
        ],
        "the finished step carries the reported findings for the run record, the refuted one left out"
    );
    assert_eq!(
        (&s["line"], &s["base"], &s["uncovered"], &s["notRun"]),
        (
            &json!("Block"),
            &json!("origin/main"),
            &json!([]),
            &json!([])
        )
    );
    finished_telemetry(&s);
    assert_eq!(status::status(&run).unwrap()["phase"], json!("done"));
    let late = step::submit(&run, Some(&Map::new())).unwrap_err();
    assert!(matches!(late, Error::Step(StepError::Done(_))), "{late}");
    assert!(late.to_string().contains("is done"), "{late}");
}

/// What the full run's finished step carries for the run record's lens yield and verification,
/// in review's record shape: a row per planned lens, the merged High under the lens that kept it.
#[expect(
    clippy::indexing_slicing,
    reason = "a step of the test above, failing loudly like it"
)]
fn finished_telemetry(s: &Value) {
    let row = |lens: &str, ran: bool, tiers: [u64; 4], high: u64| {
        let [confirmed, suspected, refuted, unverified] = tiers;
        json!({"dimension": format!("rust:{lens}"), "ran": ran, "verdict": "", "findingCount": confirmed,
               "bySeverity": {"Critical": 0, "High": high, "Medium": 0, "Low": 0, "Info": 0},
               "confirmedCount": confirmed, "suspectedCount": suspected, "refutedCount": refuted,
               "unverifiedCount": unverified, "rounds": 2})
    };
    assert_eq!(
        s["dimensions"],
        json!([
            row("errors", true, [1, 0, 1, 0], 1),
            row("intent", true, [0, 0, 0, 1], 0),
            row("tests", true, [0, 0, 0, 0], 0)
        ])
    );
    assert_eq!(
        s["verification"],
        json!({"candidates": 2, "confirmed": 1, "refuteRate": 0.5, "unverified": 1, "thinned": 0,
               "suspected": 0, "refuted": 1, "votes": {"sent": 3, "returned": 3}})
    );
    assert_eq!(
        s["lensRounds"][0],
        json!({"round": 1, "agents": 3, "returned": 3, "newFindings": 4})
    );
}

#[test]
fn a_lens_asked_again_holds_the_round_and_one_that_never_answers_makes_it_incomplete() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let (run, _) = small_run(repo.path(), out.path());
    let mut first = round1(&[]);
    first["lens-rust-errors-r1"] = json!({"lens": "errors"});
    let s = submit(&run, first);
    assert_eq!(
        ids(&s),
        ["lens-rust-errors-r1"],
        "only the refused answer is asked for again"
    );
    let p = prompt_of(&s["tasks"][0]);
    assert!(
        p.contains("Your previous answer was invalid: it does not match the schema"),
        "{p}"
    );
    let st = status::status(&run).unwrap();
    assert_eq!(st["tasks"][0]["retries"], json!(1));
    assert_eq!(st["tasks"][1]["state"], json!("answered"));
    submit(&run, json!({"lens-rust-errors-r1": "not json"}));
    let s = submit(&run, json!({}));
    assert_eq!(
        (s["done"].clone(), s["verdict"].clone()),
        (json!(true), json!("INCOMPLETE"))
    );
    let report = std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap();
    assert!(
        report.contains(
            "## Not run\n\n- rust lenses that never returned — errors: no answer was submitted"
        ),
        "{report}"
    );
    assert!(report.contains("ran: intent, tests."), "{report}");
}

#[test]
fn a_scout_that_never_answers_runs_the_conservative_plan_and_says_so() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    step::start(&opts(repo.path(), out.path())).unwrap();
    for _ in 0..2 {
        let s = submit(&run, json!({"scout-rust": {"sizeBucket": "tiny"}}));
        assert_eq!(ids(&s), ["scout-rust"]);
    }
    let s = submit(&run, json!({}));
    let lenses = ids(&s);
    assert_eq!(
        lenses.len(),
        10,
        "the security floor's roster and negative-space: {lenses:?}"
    );
    let ns = s["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == "lens-rust-negative-space-r1")
        .unwrap();
    assert!(
        prompt_of(ns).contains("You are the **negative-space** review lens for a Rust change.")
    );
    let st = status::status(&run).unwrap();
    assert!(
        st["notRun"][0]
            .as_str()
            .unwrap()
            .starts_with("rust scout classification")
    );
    let empty: Map<String, Value> = lenses
        .iter()
        .map(|id| (id.clone(), lens("x", &[])))
        .collect();
    let s = step::submit(&run, Some(&empty)).unwrap();
    // The fallback plan is security-sensitive, so its critic is asked even of an empty pool.
    assert_eq!(ids(&s), ["critic-rust"]);
    let s = common::past_critic(&run, s);
    assert_eq!(
        (s["done"].clone(), s["verdict"].clone()),
        (json!(true), json!("INCOMPLETE")),
        "a dry first round ends the lenses; the fallback plan is no clean pass"
    );
}

#[test]
fn a_run_of_low_and_info_findings_ends_unverified_with_no_verifier() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let (run, _) = small_run(repo.path(), out.path());
    let s = submit(
        &run,
        round1(&[titled("Low", 1, "a"), titled("Info", 2, "b")]),
    );
    assert_eq!(ids(&s), ["dedup-rust"]);
    let s = submit(&run, json!({"dedup-rust": {"groups": [[0, 1]]}}));
    assert_eq!(
        (s["done"].clone(), s["verdict"].clone()),
        (json!(true), json!("Approve"))
    );
    let report = std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap();
    assert!(
        report.contains("1 finding(s) reported: 0 confirmed, 0 suspected, 0 refuted, 1 unverified"),
        "the model's group merged: {report}"
    );
    assert!(
        report.contains("1 Low/Info finding(s) NOT VERIFIED"),
        "{report}"
    );
}

#[test]
fn a_batch_verdict_missing_an_index_is_asked_again() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let (run, _) = small_run(repo.path(), out.path());
    submit(
        &run,
        round1(&[titled("Medium", 1, "a"), titled("Medium", 2, "b")]),
    );
    let s = submit(&run, json!({"dedup-rust": {"groups": []}}));
    assert_eq!(ids(&s), ["verify-batch-0"]);
    let one = json!({"verdicts": [{"index": 0, "refuted": false, "citedLineMatches": true, "reachable": true, "premiseSupported": true, "behaviourIntended": false, "harmSupported": false, "confirmedHarmLevel": null, "reason": "r"}]});
    let s = submit(&run, json!({"verify-batch-0": one}));
    assert!(prompt_of(&s["tasks"][0]).contains("no verdict for index 1"));
}

#[test]
fn an_answer_for_no_pending_task_is_refused_and_changes_nothing() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    step::start(&opts(repo.path(), out.path())).unwrap();
    let err = step::submit(&run, Some(&answers(json!({"verify-7": {}})))).unwrap_err();
    assert!(
        matches!(&err, Error::Step(StepError::UnknownTask(id)) if id == "verify-7"),
        "{err}"
    );
    assert_eq!(
        err.to_string(),
        "answer for verify-7, which is no pending task of this run"
    );
    assert_eq!(
        status::status(&run).unwrap()["tasks"][0]["retries"],
        json!(0)
    );
}

#[test]
fn lenses_with_no_findings_and_a_diff_of_inert_files_both_approve() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let (run, _) = small_run(repo.path(), out.path());
    let s = submit(&run, round1(&[]));
    assert_eq!(s["verdict"], json!("Approve"));

    let repo = fixture(false);
    let out = tempfile::tempdir().unwrap();
    let s = step::start(&opts(repo.path(), out.path())).unwrap();
    assert_eq!(
        (s["done"].clone(), s["verdict"].clone()),
        (json!(true), json!("Approve (nothing to review)"))
    );
}

#[test]
fn a_light_pass_runs_one_round_of_the_scoped_lenses() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    let mut o = opts(repo.path(), out.path());
    o.light = true;
    step::start(&o).unwrap();
    let s = submit(
        &run,
        json!({"scout-rust": scout("large", &["errors", "invariants"])}),
    );
    assert_eq!(
        ids(&s),
        [
            "lens-rust-errors-r1",
            "lens-rust-intent-r1",
            "lens-rust-tests-r1"
        ]
    );
    let st = status::status(&run).unwrap();
    assert_eq!(
        st["profiles"][0]["plan"]["lightSkipped"],
        json!(["invariants", "negative-space", "compat"])
    );
    assert_eq!(st["profiles"][0]["plan"]["maxRounds"], json!(1));
    let low = titled("Low", 2, "naming");
    let s = submit(&run, round1(&[low]));
    assert_eq!(s["verdict"], json!("Approve"));
    let report = std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap();
    for want in [
        "## Verdict\n\nApprove · light pass (depth=light) -- see \"Light pass\" below for what it skipped",
        "(NOT VERIFIED: light pass: only Medium and above are verified, so no verifier was spent on this Low finding and nothing here has been checked against the code)",
        "## Light pass -- what it skipped\n⚠️ This was a LIGHT pass (depth=light), not a full review, and its verdict covers only what it ran: the whole-diff lenses invariants, negative-space, compat were NOT dispatched (it DID run intent, which the diff called for);",
    ] {
        assert!(report.contains(want), "{want}: {report}");
    }
}

#[test]
fn a_base_that_is_no_commit_is_refused() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let mut o = opts(repo.path(), out.path());
    for base in ["--output=/tmp/x", "nope"] {
        o.base = Some(base.into());
        let err = step::start(&o).unwrap_err();
        assert!(
            matches!(&err, Error::Git(GitError::NotACommit { base: b, .. }) if b == base),
            "{err}"
        );
        assert!(err.to_string().contains("is not a commit"), "{err}");
    }
}
