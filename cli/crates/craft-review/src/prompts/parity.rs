//! The prompts held to the engines' by `content/parity/prompt-cases.json`, which
//! `lib/review-prompt-parity.test.mjs` renders with `lib/review-lens-prompts.mjs` and
//! `lib/review-dedup.mjs`: the same inputs give the same text, the working-directory line aside.

use serde_json::Value;

use super::{
    LensIn, PromptContext, ReScope, adjudicate_prompt, carry_prompt, dedup_prompt, lens_prompt,
    prior_found_summary, repo_directive, scout_prompt,
};
use crate::ledger::LedgerRow;
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
        re_review: ReScope::First,
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
    let pool = input["pool"].as_array().unwrap();
    let dir = repo_directive(&ctx.repo);
    let body = |s: String| s.strip_prefix(&dir).unwrap().to_owned();
    let prior = prior_found_summary(pool);
    assert_eq!(prior, want["prior"].as_str().unwrap());
    // Each profile the engines share: its scout and the lenses the input names, from its globs.
    for (id, lenses, want) in [
        ("rust", &input["lenses"], want),
        ("nix", &input["nixLenses"], &want["nix"]),
    ] {
        let profile = Profile::load(id).unwrap();
        assert_eq!(
            body(scout_prompt(&ctx, &profile, &[]).unwrap()),
            want["scout"].as_str().unwrap(),
            "{id}"
        );
        let pathspec = profile.pathspec(&[]);
        for lens in strings(lenses) {
            let at = LensIn {
                profile: &profile,
                lens: &lens,
                plan: &plan,
                pathspec: &pathspec,
                prior: &prior,
            };
            let got = body(lens_prompt(&ctx, &at).unwrap());
            assert_eq!(got, want["lenses"][&lens].as_str().unwrap(), "{id}: {lens}");
        }
    }
    assert_eq!(
        body(dedup_prompt(&ctx, pool).unwrap()),
        want["dedup"].as_str().unwrap()
    );
    rereview(&ctx, &plan, &prior, input, want);
}

/// A re-review round's scout and `errors` lens, over the fix commits and as a full re-scan, and
/// the adjudicator of the input's prior finding.
fn rereview(ctx: &PromptContext, plan: &Plan, prior: &str, input: &Value, want: &Value) {
    let dir = repo_directive(&ctx.repo);
    let body = |s: String| s.strip_prefix(&dir).unwrap().to_owned();
    let rust = Profile::load("rust").unwrap();
    let pathspec = rust.pathspec(&[]);
    let head = input["priorHead"].as_str().unwrap();
    for (case, base, scope) in [
        ("fixes", head, ReScope::Fixes),
        ("rescan", input["base"].as_str().unwrap(), ReScope::Rescan),
    ] {
        let ctx = PromptContext {
            base: base.into(),
            re_review: scope,
            ..ctx.clone()
        };
        let want = &want["rereview"][case];
        let scout = body(scout_prompt(&ctx, &rust, &[]).unwrap());
        assert_eq!(scout, want["scout"].as_str().unwrap(), "{case}: scout");
        let at = LensIn {
            profile: &rust,
            lens: "errors",
            plan,
            pathspec: &pathspec,
            prior,
        };
        let lens = body(lens_prompt(&ctx, &at).unwrap());
        assert_eq!(lens, want["errors"].as_str().unwrap(), "{case}: errors");
    }
    let row: LedgerRow = serde_json::from_value(input["prior"].clone()).unwrap();
    let got = body(adjudicate_prompt(ctx, &row, &rust.rubric_skill).unwrap());
    assert_eq!(got, want["adjudicate"].as_str().unwrap());
    let set_aside = LedgerRow {
        disposition: "rejected".into(),
        file: "src/it's.rs".into(),
        ..row
    };
    let got = body(carry_prompt(ctx, &set_aside, head).unwrap());
    assert_eq!(got, want["carry"].as_str().unwrap());
}
