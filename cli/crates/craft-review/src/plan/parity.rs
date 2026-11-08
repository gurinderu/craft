//! The planner held to `content/parity/plan-cases.json` (each case of its profile, Rust when it
//! names none), a golden file this crate owns ([`crate::golden`]; `lib/review-profile-parity.test.mjs`
//! holds `lib/review-plan.mjs` to it too while the engines ship).

use serde_json::json;

use super::{PlanInput, plan};
use crate::golden::Golden;
use crate::profile::Profile;

#[test]
fn every_case_plans_as_the_engines_plan_it() {
    let mut g = Golden::open("plan-cases.json");
    let cases = g.file();
    let all = cases["cases"].as_array().unwrap();
    assert!(all.len() > 5);
    assert!(
        all.iter().any(|c| c["profile"] == "nix"),
        "the Nix profile is held too"
    );
    for (i, c) in all.iter().enumerate() {
        let name = c["name"].as_str().unwrap();
        let at = format!("/cases/{i}/expected");
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
            metrics: false,
            optional: &[],
        });
        let got_json = json!({
            "sizeBucket": got.size_bucket, "lenses": got.lenses, "maxRounds": got.max_rounds,
            "verifyVotes": got.verify_votes, "isLibrary": got.is_library,
            "securitySensitive": got.security_sensitive, "intent": got.intent, "churn": got.churn,
            "repoRules": got.repo_rules, "surfaceDropped": got.surface_dropped,
            "lightSkipped": got.light_skipped,
        });
        for (k, v) in got_json.as_object().unwrap() {
            g.check(&format!("{at}/{k}"), v.clone());
        }
        let model = got.lens_model(&profile);
        g.check(&format!("{at}/lensModel"), json!(model));
        for l in &got.lenses {
            assert_eq!(profile.lens(l).unwrap().model, model, "{name}: {l}");
        }
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
        metrics: true,
        optional: &[],
    });
    assert_eq!(got.lens_model(&profile), crate::agent::Model::Sonnet);
    let none = super::Plan {
        lenses: Vec::new(),
        ..got
    };
    assert_eq!(none.lens_model(&profile), crate::agent::Model::Opus);
}
