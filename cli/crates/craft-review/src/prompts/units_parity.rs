//! Unit mode's prompts held to the engine's text by `content/parity/prompt-cases.json`, which
//! `lib/review-prompt-parity.test.mjs` renders: a lens confined to a batch of two crates, a lens over
//! a directory slice of files in no crate, the contract lens of one crate, and the coordinator over
//! an open question.

use serde_json::Value;

use super::*;
use crate::plan::Plan;
use crate::profile::Profile;
use crate::units::Slice;

const CASES: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../content/parity/prompt-cases.json"
));

fn strings(v: &Value) -> Vec<String> {
    serde_json::from_value(v.clone()).unwrap()
}

fn slice(v: &Value) -> Slice {
    Slice {
        key: v["key"].as_str().unwrap().into(),
        files: strings(&v["files"]),
        units: v.get("units").map(strings).unwrap_or_default(),
    }
}

#[test]
fn unit_mode_prompts_render_as_the_engine_renders_them() {
    let file: Value = serde_json::from_str(CASES).unwrap();
    let (input, want) = (&file["input"], &file["expected"]["unit"]);
    let ctx = PromptContext {
        repo: "/work/repo".into(),
        base: input["base"].as_str().unwrap().into(),
        spec: String::new(),
        craft_root: input["craftRoot"].as_str().map(str::to_owned),
        craft_version: input["craftVersion"].as_str().map(str::to_owned),
        re_review: ReScope::First,
        strict: false,
        sources: crate::sources::Sources::default(),
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
        metrics_dropped: Vec::new(),
    };
    let rust = Profile::load("rust").unwrap();
    let words = rust.units.as_ref().unwrap();
    let prior = prior_found_summary(input["pool"].as_array().unwrap());
    let dir = repo_directive(&ctx.repo);
    let body = |s: String| s.strip_prefix(&dir).unwrap().to_owned();
    let at = LensIn {
        profile: &rust,
        lens: "errors",
        plan: &plan,
        pathspec: "",
        prior: &prior,
    };
    let unit = &input["unit"];
    let (batch, loose) = (slice(&unit["batch"]), slice(&unit["loose"]));
    for (got, name) in [
        (slice_lens_prompt(&ctx, &at, &batch), "confined"),
        (slice_lens_prompt(&ctx, &at, &loose), "loose"),
        (
            contract_prompt(&ctx, &rust, words, "crates/a", &prior, &plan.repo_rules),
            "contract",
        ),
        (
            seam_prompt(
                &ctx,
                &rust,
                words,
                &batch.units,
                unit["open"].as_array().unwrap(),
                &plan.repo_rules,
            ),
            "seam",
        ),
    ] {
        assert_eq!(body(got.unwrap()), want[name].as_str().unwrap(), "{name}");
    }
}
