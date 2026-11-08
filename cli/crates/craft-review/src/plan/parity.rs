//! The planner held to the engines' by `content/parity/plan-cases.json` (each case of its profile,
//! Rust when it names none), whose expected plans `lib/review-profile-parity.test.mjs` checks against
//! `lib/review-plan.mjs`.

use serde_json::{Value, json};

use super::{PlanInput, plan};
use crate::profile::Profile;

const CASES: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../content/parity/plan-cases.json"
));

#[test]
fn every_case_plans_as_the_engines_plan_it() {
    let cases: Value = serde_json::from_str(CASES).unwrap();
    let all = cases["cases"].as_array().unwrap();
    assert!(all.len() > 5);
    assert!(
        all.iter().any(|c| c["profile"] == "nix"),
        "the Nix profile is held too"
    );
    for c in all {
        let name = c["name"].as_str().unwrap();
        let profile = Profile::load(c["profile"].as_str().unwrap_or("rust")).unwrap();
        let files: Vec<String> = serde_json::from_value(c["changedFiles"].clone()).unwrap();
        let scout = Some(&c["scout"]).filter(|s| !s.is_null());
        let got = plan(PlanInput {
            profile: &profile,
            scout,
            changed_files: &files,
            spec: "feat: x",
            light: c["light"] == json!(true),
            strict: c["strict"] == json!(true),
        });
        let want = &c["expected"];
        let got_json = json!({
            "sizeBucket": got.size_bucket, "lenses": got.lenses, "maxRounds": got.max_rounds,
            "verifyVotes": got.verify_votes, "isLibrary": got.is_library,
            "securitySensitive": got.security_sensitive, "intent": got.intent, "churn": got.churn,
            "repoRules": got.repo_rules, "surfaceDropped": got.surface_dropped,
            "lightSkipped": got.light_skipped,
        });
        for (k, v) in got_json.as_object().unwrap() {
            assert_eq!(v, &want[k], "{name}: {k}");
        }
        for l in &got.lenses {
            assert_eq!(
                json!(profile.lens(l).unwrap().model),
                want["lensModel"],
                "{name}: {l}"
            );
        }
        assert_eq!(json!(got.lens_model(&profile)), want["lensModel"], "{name}");
    }
}

#[test]
fn a_plan_names_the_model_its_lenses_run_on() {
    let mut profile = Profile::load("rust").unwrap();
    for l in &mut profile.lenses {
        l.model = crate::agent::Model::Sonnet;
    }
    let got = plan(PlanInput {
        profile: &profile,
        scout: None,
        changed_files: &["src/lib.rs".into()],
        spec: "feat: x",
        light: false,
        strict: false,
    });
    assert_eq!(got.lens_model(&profile), crate::agent::Model::Sonnet);
    let none = super::Plan {
        lenses: Vec::new(),
        ..got
    };
    assert_eq!(none.lens_model(&profile), crate::agent::Model::Opus);
}
