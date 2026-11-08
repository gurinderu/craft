//! The general profile's complexity lens, metrics-or-nothing: it runs only when the warm-up found a
//! code-metrics index, a finding of it stands only on a number over its bar, and its one verifier
//! re-reads the metrics.

#![expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "the helpers of these tests fail loudly, like the tests they serve"
)]

mod common;

use std::path::Path;

use common::{
    assert_contains_all, fixture, git, ids, lens, opts, prompt_of, scout, submit, verdict,
};
use craft_review::step;
use serde_json::{Value, json};

/// The fixture repository with `web/app.ts` added, which the general profile takes.
fn typescript() -> tempfile::TempDir {
    let repo = fixture(false);
    let d = repo.path();
    std::fs::create_dir_all(d.join("web")).unwrap();
    std::fs::write(d.join("web/app.ts"), "export const f = () => 1\n").unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "feat: f"]);
    repo
}

/// A complexity finding at `web/app.ts:1` whose function reads `cognitive`.
fn metric(title: &str, cognitive: u64) -> Value {
    json!({"severity": "Medium", "title": title, "file": "web/app.ts", "line": 1, "why": "w",
           "fix": "extract", "blastRadius": "", "source": "complexity", "ruleId": "", "whereChecked": "query_graph",
           "metrics": {"function": "f", "cognitive": cognitive, "loop_depth": 1, "unguarded_recursion": false}})
}

/// Starts a run over the TypeScript change; the scout picks complexity, the warm-up says `indexed`.
fn planned(repo: &Path, out: &Path, indexed: bool) -> Value {
    let run = out.join("run");
    let s = step::start(&opts(repo, out)).unwrap();
    assert_eq!(ids(&s), ["scout-general", "index-warmup"]);
    assert!(prompt_of(&s["tasks"][1]).contains("You are warming up the codebase-memory index"));
    submit(
        &run,
        json!({"scout-general": scout("medium", &["complexity"]),
               "index-warmup": {"indexed": indexed, "notes": if indexed { "" } else { "no project" }}}),
    )
}

#[test]
fn without_a_code_metrics_index_the_lens_is_dropped_and_said_so() {
    let (repo, out) = (typescript(), tempfile::tempdir().unwrap());
    let s = planned(repo.path(), out.path(), false);
    assert_eq!(ids(&s), ["lens-general-correctness-r1"]);
    let run = out.path().join("run");
    let mut s = s;
    while s["done"] == json!(false) {
        let answers: serde_json::Map<String, Value> = ids(&s)
            .into_iter()
            .map(|id| (id, lens("correctness", &[])))
            .collect();
        s = submit(&run, Value::Object(answers));
    }
    let report = std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap();
    assert_contains_all(
        &report,
        &[
            "Dropped for want of a code-metrics index: complexity.",
            "codebase-memory index unavailable (no project) -> the metrics-or-nothing lenses dropped",
        ],
    );
}

#[test]
fn with_an_index_only_numbers_over_their_bar_stand_and_the_verifier_rereads_them() {
    let (repo, out) = (typescript(), tempfile::tempdir().unwrap());
    let run = out.path().join("run");
    let s = planned(repo.path(), out.path(), true);
    assert_eq!(
        ids(&s),
        ["lens-general-complexity-r1", "lens-general-correctness-r1"]
    );
    let p = prompt_of(&s["tasks"][0]);
    assert_contains_all(
        &p,
        &[
            "You are the complexity review lens, grounded in the codebase-memory knowledge graph.",
            "Step 1: detect_changes (diff base: `origin/main`)",
            "A finding stands only on a number over its bar: cognitive above 15",
        ],
    );
    let schema: Value = serde_json::from_str(
        &std::fs::read_to_string(s["tasks"][0]["schemaFile"].as_str().unwrap()).unwrap(),
    )
    .unwrap();
    assert!(
        schema["properties"]["findings"]["items"]["required"]
            .as_array()
            .unwrap()
            .contains(&json!("metrics")),
        "each finding carries its numbers"
    );
    let s = submit(
        &run,
        json!({"lens-general-complexity-r1": lens("complexity", &[metric("f is hard to follow", 22), metric("f is a bit long", 9)]),
               "lens-general-correctness-r1": lens("correctness", &[])}),
    );
    // Round 2 adds nothing; then the one finding over its bar goes to one metric verifier.
    let quiet: serde_json::Map<String, Value> = ids(&s)
        .into_iter()
        .map(|id| {
            let name = id.strip_prefix("lens-general-").unwrap();
            let name = name.split('-').next().unwrap().to_owned();
            (id, lens(&name, &[]))
        })
        .collect();
    let s = submit(&run, Value::Object(quiet));
    assert_eq!(ids(&s), ["verify-0-v0"], "one verifier, not a panel");
    let v = prompt_of(&s["tasks"][0]);
    assert_contains_all(
        &v,
        &[
            "You are an adversarial verifier for a METRIC-BACKED complexity finding.",
            "f is hard to follow",
            "[over the bar: cognitive 22 (over 15)]",
            "Metric-decided as above",
        ],
    );
    let done = submit(&run, json!({"verify-0-v0": verdict(false)}));
    assert_eq!(done["verdict"], json!("Warning"));
    let report = std::fs::read_to_string(done["report"].as_str().unwrap()).unwrap();
    assert_contains_all(
        &report,
        &["complexity: 1 finding(s) dropped — no metric over its bar"],
    );
    assert!(!report.contains("f is a bit long"), "{report}");
}
