//! The repository's own reviewing roles run as extra lenses end to end: a light pass discovers the
//! reviewer the project declares under `.claude/agents` and runs it on its own agent beside the
//! first round; a full review runs only those named, and a named one that does not answer is a gap.

#![expect(
    clippy::unwrap_used,
    reason = "the helpers are steps of the tests, failing loudly like them"
)]

mod common;

use std::path::Path;

use common::{fixture, ids, lens, opts, prompt_of, scout, submit, titled, verdict};
use craft_review::step::{self, StartOptions};
use serde_json::{Map, Value, json};

/// The project's roles: a reviewer that cannot edit, and a worker that writes code.
fn declare_roles(repo: &Path) {
    let agents = repo.join(".claude").join("agents");
    std::fs::create_dir_all(&agents).unwrap();
    std::fs::write(
        agents.join("reviewer.md"),
        "---\nname: reviewer\ndescription: Cold review of a finished batch. Not for writing fixes.\ntools: Read, Grep, Bash\n---\nBody.\n",
    )
    .unwrap();
    std::fs::write(
        agents.join("worker.md"),
        "---\nname: worker\ndescription: Mechanical execution; writes code files.\n---\n",
    )
    .unwrap();
}

/// Every pending task of `s`: the extra lens `id` with `found`, every other lens with nothing.
fn round(s: &Value, extra: &str, found: &[Value]) -> Value {
    let all: Map<String, Value> = ids(s)
        .into_iter()
        .map(|id| {
            let answer = lens("x", if id == extra { found } else { &[] });
            (id, answer)
        })
        .collect();
    Value::Object(all)
}

fn upheld(s: &Value) -> Value {
    let all: Map<String, Value> = ids(s).into_iter().map(|id| (id, verdict(false))).collect();
    Value::Object(all)
}

fn report(s: &Value) -> String {
    std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap()
}

fn task<'a>(s: &'a Value, id: &str) -> &'a Value {
    s["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == json!(id))
        .unwrap()
}

#[test]
fn a_role_lens_the_repository_declares_runs_on_a_light_pass() {
    let repo = fixture(true);
    declare_roles(repo.path());
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    step::start(&StartOptions {
        light: true,
        ..opts(repo.path(), out.path())
    })
    .unwrap();
    let s = submit(&run, json!({"scout-rust": scout("small", &["errors"])}));
    assert!(
        ids(&s).contains(&"extra-0-reviewer".to_owned()),
        "{:?}",
        ids(&s)
    );
    assert!(
        !ids(&s).iter().any(|id| id.contains("worker")),
        "a role that edits is no lens"
    );
    let t = task(&s, "extra-0-reviewer");
    assert_eq!(t["consumerAgent"], json!("reviewer"));
    let p = prompt_of(t);
    assert!(
        p.contains("supplied by this project (agent type `reviewer`)"),
        "{p}"
    );
    assert!(p.contains("READ-ONLY (hard rule)"), "{p}");

    let found = [titled("High", 1, "f claims 0 and returns 1")];
    let s = submit(&run, round(&s, "extra-0-reviewer", &found));
    let s = submit(&run, upheld(&s));
    assert_eq!(s["verdict"], json!("Block"));
    let r = report(&s);
    for want in [
        "f claims 0 and returns 1 (extra:reviewer)",
        "## Extra lenses\nChosen: discovered among the session project's agents.\nRan: reviewer. Their findings were verified under the rust profile's rubric",
        "- Round 1: 3 lens(es) dispatched",
    ] {
        assert!(r.contains(want), "{want}: {r}");
    }
}

#[test]
fn a_named_lens_that_never_answers_is_a_coverage_gap() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    step::start(&StartOptions {
        extra_lenses: Some("reviewer, ghost".into()),
        ..opts(repo.path(), out.path())
    })
    .unwrap();
    let s = submit(&run, json!({"scout-rust": scout("small", &["errors"])}));
    assert_eq!(task(&s, "extra-1-ghost")["consumerAgent"], json!("ghost"));
    let mut answers = round(&s, "extra-0-reviewer", &[]);
    answers.as_object_mut().unwrap().remove("extra-1-ghost");
    let mut s = submit(&run, answers);
    for _ in 0..2 {
        assert_eq!(
            ids(&s),
            ["extra-1-ghost"],
            "asked again, the round waits on it"
        );
        s = submit(&run, json!({}));
    }
    assert_eq!(s["verdict"], json!("INCOMPLETE"));
    let r = report(&s);
    for want in [
        "- extra lens ghost -- returned nothing (an unknown agent type on some runtimes, or a dead agent), so its review did not happen",
        "Chosen: named by the caller (extraLenses).\nRan: reviewer.",
        "- \u{26a0}\u{fe0f} coverage gap: ghost -- returned nothing",
    ] {
        assert!(r.contains(want), "{want}: {r}");
    }
}

#[test]
fn a_full_review_runs_no_role_lens_unless_named() {
    let repo = fixture(true);
    declare_roles(repo.path());
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    step::start(&opts(repo.path(), out.path())).unwrap();
    let s = submit(&run, json!({"scout-rust": scout("small", &["errors"])}));
    assert!(
        !ids(&s).iter().any(|id| id.starts_with("extra-")),
        "{:?}",
        ids(&s)
    );
}
