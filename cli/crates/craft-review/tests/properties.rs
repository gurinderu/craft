//! The reviewer's `[project]` properties end to end over a fixture repository (realm @nick/craft,
//! node #654): the run names what the profile set and its plan follows it — the rule files named,
//! the controller lenses on — and a section that could not be read is named and changes nothing.
#![expect(
    clippy::unwrap_used,
    reason = "the helpers of these tests fail loudly, like the tests they serve"
)]

mod common;

use common::{fixture, ids, opts, prompt_of, scout, submit};
use craft_review::project::properties::Properties;
use craft_review::step::{self, StartOptions};
use serde_json::{Value, json};

/// The lens step of a small run over a Rust fixture whose start takes `project` and `unread`, its
/// scout picking `errors` and naming `AGENTS.md`: the lens tasks, the intent lens's prompt and the
/// run's notes, read before its directories go.
fn lens_step(project: Properties, unread: &str) -> (Vec<String>, String, String) {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let run = out.path().join("run");
    step::start(&StartOptions {
        project,
        project_unread: unread.to_owned(),
        ..opts(repo.path(), out.path())
    })
    .unwrap();
    let s = submit(&run, json!({"scout-rust": scout("small", &["errors"])}));
    let state: Value =
        serde_json::from_str(&std::fs::read_to_string(run.join("state.json")).unwrap()).unwrap();
    let notes = state
        .get("notes")
        .and_then(Value::as_array)
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>()
        .join("\n");
    let intent = s
        .get("tasks")
        .and_then(Value::as_array)
        .unwrap()
        .iter()
        .find(|t| t["id"] == json!("lens-rust-intent-r1"))
        .unwrap();
    (ids(&s), prompt_of(intent), notes)
}

#[test]
fn the_profiles_properties_are_named_and_the_plan_follows_them() {
    let (lenses, p, notes) = lens_step(
        Properties {
            rules: Some(vec!["CONTRIBUTING.md".into(), "/etc/AGENTS.md".into()]),
            controllers: true,
            ..Properties::new()
        },
        "",
    );
    for l in ["lens-rust-reconciler-r1", "lens-rust-failure-windows-r1"] {
        assert!(lenses.contains(&l.to_owned()), "{l}: {lenses:?}");
    }
    assert!(
        p.contains("REPO RULES `CONTRIBUTING.md`")
            && !p.contains("AGENTS.md`")
            && !p.contains("/etc/AGENTS.md"),
        "the profile's rule files, not the scout's: {p}"
    );
    assert!(
        notes.contains("the reviewer's profile sets the project's properties — rule files: CONTRIBUTING.md, /etc/AGENTS.md; controllers: yes"),
        "{notes}"
    );
    assert!(
        notes.contains("rule files /etc/AGENTS.md were left out")
            && !notes.contains("CONTRIBUTING.md were"),
        "a refused rule file is named: {notes}"
    );
}

#[test]
fn a_section_that_could_not_be_read_is_named_and_the_scout_is_taken() {
    let (lenses, _, notes) = lens_step(Properties::new(), "review.toml: [project]: unknown field");
    assert_eq!(
        lenses,
        [
            "lens-rust-errors-r1",
            "lens-rust-intent-r1",
            "lens-rust-tests-r1"
        ]
    );
    assert!(
        notes.contains(
            "[project] section could not be read (review.toml: [project]: unknown field)"
        ),
        "{notes}"
    );
    let (_, _, clean) = lens_step(Properties::new(), "");
    assert!(
        !clean.contains("[project]") && !clean.contains("properties"),
        "{clean}"
    );
}
