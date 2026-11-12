//! The general profile's complexity lens, metrics-or-nothing: it runs only when the warm-up found a
//! code-metrics index, a finding of it stands only on the metrics it carries (no cutoff, as the
//! engine sets none), and its one verifier re-reads them.

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

/// A complexity finding at `web/app.ts:1` carrying `metrics`.
fn metric(title: &str, metrics: &Value) -> Value {
    json!({"severity": "Medium", "title": title, "file": "web/app.ts", "line": 1, "why": "w",
           "fix": "extract", "blastRadius": "", "source": "complexity", "ruleId": "", "whereChecked": "query_graph",
           "metrics": metrics})
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
fn with_an_index_a_finding_stands_on_the_metrics_it_carries_and_the_verifier_rereads_them() {
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
            "A finding that carries no value read from the graph is dropped unread",
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
        json!({"lens-general-complexity-r1": lens("complexity", &[metric("f is hard to follow", &json!({"function": "f", "cognitive": 3, "loop_depth": 1, "unguarded_recursion": false})), metric("f is a bit long", &json!({"function": "f"}))]),
               "lens-general-correctness-r1": lens("correctness", &[])}),
    );
    // Round 2 adds nothing; then the one finding with metrics goes to one metric verifier.
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
            "[metrics: cognitive 3, loop_depth 1]",
            "Metric-decided as above",
        ],
    );
    let done = submit(&run, json!({"verify-0-v0": verdict(false)}));
    assert_eq!(done["verdict"], json!("Warning"));
    let report = std::fs::read_to_string(done["report"].as_str().unwrap()).unwrap();
    assert_contains_all(
        &report,
        &["complexity: 1 finding(s) dropped — they carry no metric value read from the graph"],
    );
    assert!(!report.contains("f is a bit long"), "{report}");
}
