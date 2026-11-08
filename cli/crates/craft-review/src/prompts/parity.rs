//! The prompts held to `content/parity/prompt-cases.json`, a golden file this crate owns
//! ([`crate::golden`]; `lib/review-prompt-parity.test.mjs` holds the engines' renderers to it too
//! while they ship): the same inputs give the same text, the working-directory line aside.

use serde_json::Value;

use super::{
    LensIn, PromptContext, ReScope, adjudicate_prompt, batch_verify_prompt, carry_prompt,
    dedup_prompt, lens_prompt, prior_found_summary, red_team_prompt, repo_directive, scout_prompt,
    verify_prompt,
};
use crate::golden::Golden;
use crate::ledger::LedgerRow;
use crate::plan::Plan;
use crate::profile::Profile;
use crate::sources::{Prepared, Sources, lens_block, verify_block};

fn strings(v: &Value) -> Vec<String> {
    serde_json::from_value(v.clone()).unwrap()
}

/// `s` without the working-directory line it opens with.
fn body(ctx: &PromptContext, s: String) -> String {
    s.strip_prefix(&repo_directive(&ctx.repo))
        .unwrap()
        .to_owned()
}

#[test]
fn every_prompt_renders_as_the_engines_render_it() {
    let mut g = Golden::open("prompt-cases.json");
    let file = g.file();
    let input = &file["input"];
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
    let pool = input["pool"].as_array().unwrap();
    let prior = prior_found_summary(pool);
    g.check("/expected/prior", prior.clone());
    // Each profile the engines share: its scout and the lenses the input names, from its globs.
    for (id, lenses, at) in [
        ("rust", &input["lenses"], "/expected"),
        ("nix", &input["nixLenses"], "/expected/nix"),
    ] {
        let profile = Profile::load(id).unwrap();
        g.check(
            &format!("{at}/scout"),
            body(&ctx, scout_prompt(&ctx, &profile, &[]).unwrap()),
        );
        let pathspec = profile.pathspec(&[]);
        for lens in strings(lenses) {
            let at_lens = LensIn {
                profile: &profile,
                lens: &lens,
                plan: &plan,
                pathspec: &pathspec,
                prior: &prior,
            };
            let got = body(&ctx, lens_prompt(&ctx, &at_lens).unwrap());
            g.check(&format!("{at}/lenses/{lens}"), got);
        }
    }
    g.check(
        "/expected/dedup",
        body(&ctx, dedup_prompt(&ctx, pool).unwrap()),
    );
    rereview(&mut g, &ctx, &plan, &prior, input);
    strict(&mut g, &ctx, &plan, &prior);
    sources(&mut g, &ctx, &plan, &prior, input);
    verifiers(&mut g, &ctx, input);
    complexity(&mut g, &ctx, &plan, &prior);
}

/// The general profile's complexity lens — the engine's prompt, then what its findings carry here —,
/// its index warm-up, and the verifier of one of its findings, whose head is the engine's.
fn complexity(g: &mut Golden, ctx: &PromptContext, plan: &Plan, prior: &str) {
    let general = Profile::load("general").unwrap();
    let pathspec = general.pathspec(&["web/app.ts".into()]);
    let at = LensIn {
        profile: &general,
        lens: "complexity",
        plan,
        pathspec: &pathspec,
        prior,
    };
    let lens = body(ctx, lens_prompt(ctx, &at).unwrap());
    let carried = format!("\n\n{}", crate::content::text("lens-metrics").unwrap());
    let shared = lens
        .strip_suffix(&carried)
        .unwrap_or_else(|| panic!("what the findings carry closes it: {lens}"));
    g.check("/expected/complexity/lens", shared);
    let warmup = crate::complexity::warmup_task(&ctx.repo).unwrap();
    g.check("/expected/complexity/warmup", body(ctx, warmup.prompt));
    let head = crate::content::text("verify-metric").unwrap();
    g.check("/expected/complexity/verify", head.clone());
    let f = serde_json::json!({"severity": "High", "title": "t", "file": "web/app.ts", "line": 1, "why": "w",
        "source": "complexity", "metrics": {"function": "f", "cognitive": 30}});
    let v = body(ctx, verify_prompt(ctx, &general, &f, 0, "").unwrap());
    assert!(v.starts_with(&head), "{v}");
}

/// A gate tool's seed under the tool's own verifier, and a lens finding's, each told how the gate
/// ran its tools.
fn verifiers(g: &mut Golden, ctx: &PromptContext, input: &Value) {
    let rust = Profile::load("rust").unwrap();
    let gate = input["gateProvenance"].as_str().unwrap();
    for (case, f, voter) in [
        ("tool", &input["gateSeed"], 0),
        ("lens", &input["pool"][1], 1),
    ] {
        let got = body(ctx, verify_prompt(ctx, &rust, f, voter, gate).unwrap());
        g.check(&format!("/expected/verify/{case}"), got);
    }
}

/// The prepared sources' blocks, the reconciler lens that reads them and the tests lens that does
/// not, and a verifier given the block.
fn sources(g: &mut Golden, ctx: &PromptContext, plan: &Plan, prior: &str, input: &Value) {
    let prepared: Vec<Prepared> = serde_json::from_value(input["sources"].clone()).unwrap();
    g.check("/expected/sources/lens", lens_block(&prepared));
    let block = verify_block(&prepared);
    g.check("/expected/sources/verify", block.clone());
    let ctx = PromptContext {
        sources: Sources {
            prepared,
            ..Sources::default()
        },
        ..ctx.clone()
    };
    let rust = Profile::load("rust").unwrap();
    let pathspec = rust.pathspec(&[]);
    for lens in ["reconciler", "tests"] {
        let at = LensIn {
            profile: &rust,
            lens,
            plan,
            pathspec: &pathspec,
            prior,
        };
        g.check(
            &format!("/expected/sources/{lens}"),
            body(&ctx, lens_prompt(&ctx, &at).unwrap()),
        );
    }
    let finding = &input["pool"][0];
    assert!(
        verify_prompt(&ctx, &rust, finding, 0, "")
            .unwrap()
            .contains(&block)
    );
    assert!(
        batch_verify_prompt(&ctx, &rust, &[finding])
            .unwrap()
            .contains(&block)
    );
}

/// Strict mode's scout and maintainability lens.
fn strict(g: &mut Golden, ctx: &PromptContext, plan: &Plan, prior: &str) {
    let strict = PromptContext {
        strict: true,
        ..ctx.clone()
    };
    let rust = Profile::load("rust").unwrap();
    g.check(
        "/expected/strict/scout",
        body(ctx, scout_prompt(&strict, &rust, &[]).unwrap()),
    );
    let pathspec = rust.pathspec(&[]);
    let at = LensIn {
        profile: &rust,
        lens: "maintainability",
        plan,
        pathspec: &pathspec,
        prior,
    };
    let lens = body(ctx, lens_prompt(&strict, &at).unwrap());
    g.check("/expected/strict/maintainability", lens);
}

/// A re-review round's scout and `errors` lens, over the fix commits and as a full re-scan, and
/// the adjudicator of the input's prior finding.
fn rereview(g: &mut Golden, ctx: &PromptContext, plan: &Plan, prior: &str, input: &Value) {
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
        let at = format!("/expected/rereview/{case}");
        g.check(
            &format!("{at}/scout"),
            body(&ctx, scout_prompt(&ctx, &rust, &[]).unwrap()),
        );
        let errors = LensIn {
            profile: &rust,
            lens: "errors",
            plan,
            pathspec: &pathspec,
            prior,
        };
        g.check(
            &format!("{at}/errors"),
            body(&ctx, lens_prompt(&ctx, &errors).unwrap()),
        );
    }
    let row: LedgerRow = serde_json::from_value(input["prior"].clone()).unwrap();
    let got = body(
        ctx,
        adjudicate_prompt(ctx, &row, &rust.rubric_skill).unwrap(),
    );
    g.check("/expected/adjudicate", got);
    let set_aside = LedgerRow {
        disposition: "rejected".into(),
        file: "src/it's.rs".into(),
        ..row
    };
    g.check(
        "/expected/carry",
        body(ctx, carry_prompt(ctx, &set_aside, head).unwrap()),
    );
    let invariant = input["redTeam"]["invariant"].as_str().unwrap();
    for (case, named) in [("invariant", invariant), ("fallback", "")] {
        let got = body(
            ctx,
            red_team_prompt(ctx, &set_aside_row(input), named).unwrap(),
        );
        g.check(&format!("/expected/redTeam/{case}"), got);
    }
}

/// The input's prior finding as its ledger row.
fn set_aside_row(input: &Value) -> LedgerRow {
    serde_json::from_value(input["prior"].clone()).unwrap()
}
