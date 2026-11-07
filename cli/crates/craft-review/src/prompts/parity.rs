//! The prompts held to the engines' by `content/parity/prompt-cases.json`, which
//! `lib/review-prompt-parity.test.mjs` renders with `lib/review-lens-prompts.mjs` and
//! `lib/review-dedup.mjs`: the same inputs give the same text, the working-directory line aside.

use serde_json::Value;

use super::{
    PromptContext, dedup_prompt, lens_prompt, prior_found_summary, repo_directive, scout_prompt,
};
use crate::plan::Plan;
use crate::profile::Profile;

const CASES: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../content/parity/prompt-cases.json"
));

fn strings(v: &Value) -> Vec<String> {
    serde_json::from_value(v.clone()).unwrap()
}

#[test]
fn every_prompt_renders_as_the_engines_render_it() {
    let file: Value = serde_json::from_str(CASES).unwrap();
    let (input, want) = (&file["input"], &file["expected"]);
    let ctx = PromptContext {
        repo: "/work/repo".into(),
        base: input["base"].as_str().unwrap().into(),
        spec: String::new(),
        craft_root: input["craftRoot"].as_str().map(str::to_owned),
        craft_version: input["craftVersion"].as_str().map(str::to_owned),
    };
    let p = &input["plan"];
    let plan = Plan {
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
    };
    let profile = Profile::rust().unwrap();
    let pool = input["pool"].as_array().unwrap();
    let dir = repo_directive(&ctx.repo);
    let body = |s: String| s.strip_prefix(&dir).unwrap().to_owned();
    let prior = prior_found_summary(pool);
    assert_eq!(prior, want["prior"].as_str().unwrap());
    assert_eq!(
        body(scout_prompt(&ctx, &profile).unwrap()),
        want["scout"].as_str().unwrap()
    );
    for lens in strings(&input["lenses"]) {
        let got = body(lens_prompt(&ctx, &profile, &lens, &plan, &prior).unwrap());
        assert_eq!(got, want["lenses"][&lens].as_str().unwrap(), "{lens}");
    }
    assert_eq!(
        body(dedup_prompt(&ctx, pool).unwrap()),
        want["dedup"].as_str().unwrap()
    );
}
