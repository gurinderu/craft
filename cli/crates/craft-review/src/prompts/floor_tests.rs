//! The test-promise floor reaches the tests lens and a test gap's verifier (realm @nick/craft,
//! node #619).

use serde_json::json;

use super::{LensIn, PromptContext, lens_prompt, verify_prompt};
use crate::harm::PROMISE_FLOOR;
use crate::plan::Plan;
use crate::profile::Profile;

fn plan(lens: &str) -> Plan {
    serde_json::from_value(json!({
        "sizeBucket": "small", "lenses": [lens], "maxRounds": 1, "verifyVotes": 1,
        "isLibrary": false, "securitySensitive": false, "intent": "", "spec": "", "churn": [],
        "repoRules": [], "surfaceDropped": [], "lightSkipped": []
    }))
    .unwrap()
}

fn render(profile: &str, lens: &str, ctx: &PromptContext) -> String {
    let (p, plan) = (Profile::load(profile).unwrap(), plan(lens));
    let at = LensIn {
        profile: &p,
        lens,
        plan: &plan,
        pathspec: "'*.rs'",
        prior: "none yet",
    };
    lens_prompt(ctx, &at).unwrap()
}

#[test]
fn the_test_promise_floor_reaches_the_tests_lens_and_its_verifier() {
    let ctx = PromptContext::default();
    for profile in ["general", "rust"] {
        let got = render(profile, "tests", &ctx);
        assert!(got.contains(PROMISE_FLOOR), "{profile}: {got}");
    }
    assert!(!render("general", "correctness", &ctx).contains(PROMISE_FLOOR));
    let gap = json!({"severity": "Low", "title": "t", "file": "src/a_test.rs", "line": 3,
                     "why": "w", "source": "tests", "harmLevel": "intent-unmet",
                     "testGap": "weak-assertion", "regression": "any message passes"});
    let general = Profile::load("general").unwrap();
    let verifier = verify_prompt(&ctx, &general, &gap, 0, "").unwrap();
    assert!(verifier.contains(PROMISE_FLOOR), "{verifier}");
    let plain = json!({"severity": "Low", "title": "t", "file": "src/a.rs", "line": 3,
                       "why": "w", "source": "correctness"});
    let other = verify_prompt(&ctx, &general, &plain, 0, "").unwrap();
    assert!(!other.contains(PROMISE_FLOOR), "only a test gap's verifier");
}

#[test]
fn the_floor_never_reaches_a_raised_weak_assertion_or_a_missing_test() {
    let ctx = PromptContext::default();
    let general = Profile::load("general").unwrap();
    let with = |severity: &str, kind: &str| {
        let f = json!({"severity": severity, "title": "t", "file": "src/a_test.rs", "line": 3,
                       "why": "w", "source": "tests", "harmLevel": "intent-unmet",
                       "testGap": kind, "regression": "any message passes"});
        verify_prompt(&ctx, &general, &f, 0, "").unwrap()
    };
    assert!(with("Info", "weak-assertion").contains(PROMISE_FLOOR));
    for (severity, kind) in [
        ("Medium", "weak-assertion"),
        ("High", "weak-assertion"),
        ("Low", "missing"),
        ("High", "missing"),
    ] {
        assert!(
            !with(severity, kind).contains(PROMISE_FLOOR),
            "{severity} {kind}"
        );
    }
}

#[test]
fn the_rust_tests_lens_is_told_the_mutants_run_only_when_the_binary_runs_them() {
    let said = "MUTANTS: the binary runs cargo-mutants";
    let running = PromptContext {
        mutants: true,
        ..PromptContext::default()
    };
    assert!(render("rust", "tests", &running).contains(said));
    assert!(!render("rust", "tests", &PromptContext::default()).contains(said));
    assert!(
        !render("rust", "errors", &running).contains(said),
        "only the tests lens"
    );
    assert!(
        !render("general", "tests", &running).contains(said),
        "only Rust's"
    );
}
