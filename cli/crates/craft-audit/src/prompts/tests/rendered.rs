//! The verifier's prompt, and the context every prompt of a run is rendered with.

use craft_review::profile::Profile;
use serde_json::json;

use super::ctx;
use crate::prompts::{verify_prompt, verify_schema};

#[test]
fn a_verifier_prompt_judges_each_finding_of_its_batch_by_index() {
    let general = Profile::load("general").unwrap();
    let f = json!({"severity": "Medium", "title": "t", "file": "a.py", "line": 3, "why": "w", "source": "errors"});
    let p = verify_prompt(&ctx(None), &general, &[&f, &f]).unwrap();
    assert!(
        p.contains("verifying 2 INDEPENDENT") && p.contains("(0..1)"),
        "{p}"
    );
    assert_eq!(verify_schema().unwrap()["required"], json!(["verdicts"]));
}

#[test]
fn the_prompts_are_rendered_for_the_runs_repository_and_craft_release() {
    let mut s = crate::state::AuditState {
        version: crate::state::STATE_VERSION,
        cwd: "/the/repo".into(),
        args: crate::state::Args {
            craft_version: "9.9.9".into(),
            craft_root: Some("/craft".into()),
            ..crate::state::Args::default()
        },
        scout: crate::scout::Scouted::default(),
        phase: crate::state::Phase::Lens,
        pass: 1,
        tasks: Vec::new(),
        degraded: Vec::new(),
        notes: Vec::new(),
        stopped: None,
    };
    let c = crate::prompts::context(&s);
    assert_eq!(c.repo, "/the/repo");
    assert_eq!(c.craft_root.as_deref(), Some("/craft"));
    assert_eq!(c.craft_version.as_deref(), Some("9.9.9"));
    s.args.craft_version = String::new();
    assert_eq!(crate::prompts::context(&s).craft_version, None);
}
