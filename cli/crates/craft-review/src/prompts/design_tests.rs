//! The design lens's prompt: its brief and the seed the run prepared; another lens carries no seed.

use super::{LensIn, PromptContext, lens_prompt};
use crate::design::Seed;
use crate::plan::Plan;
use crate::profile::Profile;

fn plan() -> Plan {
    serde_json::from_value(serde_json::json!({
        "sizeBucket": "medium", "lenses": ["design"], "maxRounds": 1, "verifyVotes": 1,
        "isLibrary": false, "securitySensitive": false, "intent": "", "spec": "", "churn": [],
        "repoRules": [], "surfaceDropped": [], "lightSkipped": []
    }))
    .unwrap()
}

fn render(profile: &Profile, lens: &str, ctx: &PromptContext) -> String {
    let plan = plan();
    let at = LensIn {
        profile,
        lens,
        plan: &plan,
        pathspec: "'*.rs'",
        prior: "none yet",
    };
    lens_prompt(ctx, &at).unwrap()
}

#[test]
fn the_design_lens_carries_its_brief_and_seed_and_no_other_lens_does() {
    let ctx = PromptContext {
        repo: "/work/repo".into(),
        base: "origin/main".into(),
        design: Seed {
            structure: vec!["new crate: c/Cargo.toml".into()],
            crates: vec!["new cycle: b -> c -> b (closed by the new edge b -> c)".into()],
            note: String::new(),
        },
        ..PromptContext::default()
    };
    for id in ["rust", "general"] {
        let p = Profile::load(id).unwrap();
        let got = render(&p, "design", &ctx);
        assert!(got.contains("INVENTORY THE DECISIONS"), "{id}");
        assert!(got.contains("SECOND IMPLEMENTATION"), "{id}");
        assert!(got.contains("- new crate: c/Cargo.toml"), "{id}: {got}");
        assert!(got.contains("- new cycle: b -> c -> b"), "{id}");
        assert!(
            !render(&p, "correctness", &ctx).contains("STRUCTURE THIS CHANGE ADDS"),
            "{id}"
        );
    }
    let bare = render(
        &Profile::load("general").unwrap(),
        "design",
        &PromptContext::default(),
    );
    assert!(
        !bare.contains("STRUCTURE THIS CHANGE ADDS"),
        "optional=design with no signal: no seed"
    );
}
