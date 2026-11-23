//! What the runbook lens is told: it walks the steps and reads the integration points' sources
//! when the run prepared them (realm @nick/craft, node #620).

use serde_json::json;

use super::{LensIn, PromptContext, lens_prompt};
use crate::plan::Plan;
use crate::profile::Profile;
use crate::sources::{Prepared, Sources};

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
        pathspec: "'RUNBOOK.md'",
        prior: "none yet",
    };
    lens_prompt(ctx, &at).unwrap()
}

fn with_sources() -> PromptContext {
    PromptContext {
        repo: "/work/repo".into(),
        base: "origin/main".into(),
        sources: Sources {
            prepared: vec![Prepared {
                system: "kube-ovn".into(),
                rev: "v1.14.0".into(),
                dir: "/cache/kube-ovn".into(),
            }],
            ..Sources::default()
        },
        ..PromptContext::default()
    }
}

#[test]
fn the_runbook_lens_walks_the_steps_and_names_the_integration_sources_when_the_run_has_them() {
    let got = render("runbook", "runbook", &with_sources());
    assert!(got.contains("a Markdown runbook diff"), "{got}");
    assert!(got.contains("RUNBOOKS"), "{got}");
    assert!(got.contains("runbooks.md"), "{got}");
    assert!(got.contains("EXTERNAL SOURCES (read-only"), "{got}");
    assert!(
        got.contains("- kube-ovn @ v1.14.0: /cache/kube-ovn"),
        "{got}"
    );
    let bare = render("runbook", "runbook", &PromptContext::default());
    assert!(
        !bare.contains("EXTERNAL SOURCES (read-only"),
        "none prepared: no block"
    );
}
