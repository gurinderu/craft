//! Held to the engines' text by `content/parity/prompt-cases.json`, which
//! `lib/review-prompt-parity.test.mjs` renders: the critic over the Rust plan of the input's
//! lenses, an `errors` follow-up it admitted, the extra lens `reviewer`, and the scout and extra
//! lens of a review scoped to one directory.

use serde_json::Value;

use super::*;
use crate::plan::Plan;
use crate::profile::Profile;
use crate::prompts::{LensIn, ReScope, lens_prompt, prior_found_summary};

const CASES: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../content/parity/prompt-cases.json"
));

fn strings(v: &Value) -> Vec<String> {
    serde_json::from_value(v.clone()).unwrap()
}

/// The parity input's plan, its lenses aside.
fn plan_of(p: &Value) -> Plan {
    Plan {
        size_bucket: p["sizeBucket"].as_str().unwrap().into(),
        lenses: Vec::new(),
        max_rounds: 2,
        verify_votes: 1,
        is_library: false,
        security_sensitive: false,
        intent: p["intent"].as_str().unwrap().into(),
        spec: p["spec"].as_str().unwrap().into(),
        churn: strings(&p["churn"]),
        repo_rules: strings(&p["repoRules"]),
        surface_dropped: Vec::new(),
        light_skipped: Vec::new(),
        metrics_dropped: Vec::new(),
    }
}

#[test]
fn the_critic_its_follow_up_and_an_extra_lens_render_as_the_engines_do() {
    let file: Value = serde_json::from_str(CASES).unwrap();
    let (input, want) = (&file["input"], &file["expected"]);
    let ctx = PromptContext {
        repo: "/work/repo".into(),
        base: input["base"].as_str().unwrap().into(),
        spec: String::new(),
        craft_root: input["craftRoot"].as_str().map(str::to_owned),
        craft_version: input["craftVersion"].as_str().map(str::to_owned),
        re_review: ReScope::First,
        strict: false,
        sources: crate::sources::Sources::default(),
        scope: None,
    };
    let dir = repo_directive(&ctx.repo);
    let body = |s: String| s.strip_prefix(&dir).unwrap().to_owned();
    let rust = Profile::load("rust").unwrap();
    let lenses = strings(&input["lenses"]);
    let candidates: Vec<String> = rust
        .roster()
        .into_iter()
        .filter(|l| !lenses.contains(l))
        .collect();
    let at = CriticIn {
        lang: &rust.lang,
        lenses: &lenses,
        confirmed: 1,
        suspected: 2,
        candidates: &candidates,
    };
    let got = body(critic_prompt(&ctx, &at).unwrap());
    assert_eq!(got, want["critic"]["prompt"].as_str().unwrap());

    let plan = plan_of(&input["plan"]);
    let pool = input["pool"].as_array().unwrap();
    let told = critic_prior(pool.len()).unwrap();
    let pathspec = rust.pathspec(&[]);
    let follow = LensIn {
        profile: &rust,
        lens: "errors",
        plan: &plan,
        pathspec: &pathspec,
        prior: &told,
    };
    let got = body(lens_prompt(&ctx, &follow).unwrap());
    assert_eq!(got, want["critic"]["followup"].as_str().unwrap());

    let prior = prior_found_summary(pool);
    let got = body(extra_lens_prompt(&ctx, "reviewer", &prior, &plan.repo_rules).unwrap());
    assert_eq!(got, want["extraLens"].as_str().unwrap());

    // A review scoped to one directory: the scout told it, the extra lens's diff limited to it.
    let scoped = PromptContext {
        scope: input["scope"].as_str().map(str::to_owned),
        ..ctx
    };
    let got = body(crate::prompts::scout_prompt(&scoped, &rust, &[]).unwrap());
    assert_eq!(got, want["scoped"]["scout"].as_str().unwrap());
    let got = body(extra_lens_prompt(&scoped, "reviewer", &prior, &plan.repo_rules).unwrap());
    assert_eq!(got, want["scoped"]["extraLens"].as_str().unwrap());
}
