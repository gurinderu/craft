use craft_review::profile::Profile;
use craft_review::prompts::PromptContext;
use craft_step::Model;

use super::{lens_prompt, lens_schema, written};
use crate::batch::Tracked;
use crate::kind::AuditKind;
use crate::state::Task;

mod rendered;

pub(super) fn ctx(root: Option<String>) -> PromptContext {
    PromptContext {
        repo: "/the/repo".into(),
        craft_root: root,
        ..PromptContext::default()
    }
}

fn checkout() -> String {
    format!(
        "{}/../../../integrations/claude-code",
        env!("CARGO_MANIFEST_DIR")
    )
}

fn files() -> Vec<Tracked> {
    vec![
        Tracked {
            path: "src/a.rs".into(),
            bytes: 40,
        },
        Tracked {
            path: "src/b.rs".into(),
            bytes: 2,
        },
    ]
}

#[test]
fn a_lens_prompt_names_its_whole_files_its_brief_and_rubric_and_no_diff() {
    let rust = Profile::load("rust").unwrap();
    let lens = rust.lens("safety").unwrap();
    let p = lens_prompt(&ctx(None), &rust, lens, &files()).unwrap();
    assert!(
        p.starts_with("WORKING DIRECTORY: this audit targets the repository at '/the/repo'"),
        "{p}"
    );
    assert!(
        p.contains("**safety** lens of an audit of a whole project's Rust code"),
        "{p}"
    );
    assert!(p.contains("FILES (2 file(s), 42 bytes)"), "{p}");
    assert!(
        p.contains("- `src/a.rs` (40 bytes)\n- `src/b.rs` (2 bytes)"),
        "{p}"
    );
    let brief = craft_review::content::text(&lens.brief).unwrap();
    assert!(p.contains(&brief), "the brief is carried whole");
    assert!(
        p.contains("the rust-review skill") && p.contains("the rust-navigation skill"),
        "{p}"
    );
    assert!(p.contains("REVIEW RULES (all languages)"), "{p}");
    assert!(!p.contains("git diff") && !p.contains("{{"), "{p}");
}

#[test]
fn a_lens_with_a_catalogue_carries_it_and_a_profile_without_a_rule_catalog_says_so() {
    let rust = Profile::load("rust").unwrap();
    let rec = lens_prompt(
        &ctx(None),
        &rust,
        rust.lens("reconciler").unwrap(),
        &files(),
    )
    .unwrap();
    assert!(rec.contains("RACE CATALOGUE"), "{rec}");
    let general = Profile::load("general").unwrap();
    let p = lens_prompt(
        &ctx(None),
        &general,
        general.lens("errors").unwrap(),
        &files(),
    )
    .unwrap();
    assert!(p.contains("this profile has no rule catalog"), "{p}");
    assert!(!p.contains("LSP"), "{p}");
}

#[test]
fn a_written_task_points_at_the_skill_files_it_names_and_at_saying_it_could_not_look() {
    let rust = Profile::load("rust").unwrap();
    let c = ctx(Some(checkout()));
    let prompt = lens_prompt(&c, &rust, rust.lens("safety").unwrap(), &files()).unwrap();
    let kind = AuditKind::Lens {
        profile: "rust".into(),
        lens: "safety".into(),
        batch: 0,
    };
    let task = Task::new(
        "l".into(),
        "l".into(),
        prompt,
        Model::Opus,
        lens_schema().unwrap(),
        kind,
    );
    let w = written(&c, &task).unwrap();
    assert!(
        w.contains("SKILL FILES:") && w.contains("skills/rust-review/SKILL.md"),
        "{w}"
    );
    assert!(w.contains("couldNotLook"), "{w}");
}
