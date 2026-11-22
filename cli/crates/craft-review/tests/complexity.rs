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

/// Starts a run over the TypeScript change, the reviewer's profile recording `graph` as its code
/// graph; the scout picks complexity. No warm-up agent is dispatched, and no prompt tells an
/// agent to index: the binary alone indexes the graph (realm @nick/craft, node #529).
fn planned(repo: &Path, out: &Path, graph: (Option<&Path>, &Path)) -> Value {
    let run = out.join("run");
    let s = step::start(&common::cbm::with_profile(opts(repo, out), out, graph)).unwrap();
    assert_eq!(ids(&s), ["scout-general"]);
    for t in s["tasks"].as_array().unwrap() {
        let p = prompt_of(t);
        assert!(
            !p.contains("index_repository"),
            "an agent is told to index: {p}"
        );
    }
    submit(
        &run,
        json!({"scout-general": scout("medium", &["complexity"])}),
    )
}

#[test]
fn without_a_code_metrics_index_the_lens_is_dropped_and_said_so() {
    let (repo, out) = (typescript(), tempfile::tempdir().unwrap());
    // No profile entry, and no program answering where the review looks for one.
    let missing = out.path().join("no-codebase-memory-mcp");
    let s = planned(repo.path(), out.path(), (None, &missing));
    assert_eq!(
        ids(&s),
        [
            "lens-general-correctness-r1",
            "lens-general-intent-r1",
            "lens-general-tests-r1",
            "lens-general-design-r1"
        ]
    );
    let run = out.path().join("run");
    let mut s = s;
    while s["done"] == json!(false) {
        let answers: serde_json::Map<String, Value> = ids(&s)
            .into_iter()
            .map(|id| {
                let name = id.strip_prefix("lens-general-").unwrap();
                let name = name.split('-').next().unwrap().to_owned();
                (id, lens(&name, &[]))
            })
            .collect();
        s = submit(&run, Value::Object(answers));
    }
    let report = std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap();
    assert_contains_all(
        &report,
        &[
            "Dropped for want of the code graph's numbers (the note or the coverage gap says why): complexity.",
            "the complexity lens did not run: the codebase-memory index is unavailable (the review profile names no code graph, and",
            "did not answer",
        ],
    );
}

#[test]
fn with_an_index_a_finding_stands_on_the_metrics_it_carries_and_the_verifier_rereads_them() {
    let (repo, out) = (typescript(), tempfile::tempdir().unwrap());
    let run = out.path().join("run");
    let graphs = tempfile::tempdir().unwrap();
    let (tool, log) = common::cbm::stand_in(graphs.path(), repo.path());
    let s = planned(
        repo.path(),
        out.path(),
        (Some(&tool), &out.path().join("unused")),
    );
    // Indexed once, by the binary, under craft's own project.
    let calls = std::fs::read_to_string(&log).unwrap();
    assert_eq!(calls.lines().count(), 1, "{calls}");
    assert!(
        calls.contains(r#""name":"craft-review-"#) && calls.contains(r#""mode":"full""#),
        "{calls}"
    );
    assert_eq!(
        ids(&s),
        [
            "lens-general-complexity-r1",
            "lens-general-correctness-r1",
            "lens-general-intent-r1",
            "lens-general-tests-r1",
            "lens-general-design-r1"
        ]
    );
    // A judging lens names its rubric's file by an absolute path any agent can read.
    let rules = prompt_of(&s["tasks"][1]);
    let line = rules
        .lines()
        .find(|l| l.starts_with("- `review-rules`: `"))
        .unwrap_or_else(|| panic!("{rules}"));
    let path = line.split('`').nth(3).unwrap();
    assert!(
        Path::new(path).is_absolute() && Path::new(path).is_file(),
        "{path}"
    );
    let p = prompt_of(&s["tasks"][0]);
    assert_contains_all(
        &p,
        &[
            "You are the complexity review lens. This lens is metrics-or-nothing",
            "You need no MCP tool and no ToolSearch",
            r#"- `web/app.ts:1-1` `f`: {"alloc_in_loop":false,"cognitive":3,"complexity":2,"linear_scan_in_loop":false,"loop_depth":1,"param_count":0,"recursion_in_loop":false,"transitive_loop_depth":1,"unguarded_recursion":false}"#,
            "A finding that carries no value from the table is dropped unread",
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
               "lens-general-correctness-r1": lens("correctness", &[]),
               "lens-general-intent-r1": lens("intent", &[]),
               "lens-general-tests-r1": lens("tests", &[]),
               "lens-general-design-r1": lens("design", &[])}),
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
            "you need no MCP tool. Its rows for this finding's function:",
            "f is hard to follow",
            "[metrics: cognitive 3, loop_depth 1]",
            "Its rows for this finding's function:\n- `web/app.ts:1-1` `f`:",
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

#[test]
fn a_graph_answering_where_no_profile_records_one_is_indexed_and_the_lens_runs() {
    let (repo, out) = (typescript(), tempfile::tempdir().unwrap());
    let graphs = tempfile::tempdir().unwrap();
    let (tool, log) = common::cbm::stand_in(graphs.path(), repo.path());
    let s = planned(repo.path(), out.path(), (None, &tool));
    let calls = std::fs::read_to_string(&log).unwrap();
    assert_eq!(calls.lines().count(), 1, "{calls}");
    assert_eq!(
        ids(&s),
        [
            "lens-general-complexity-r1",
            "lens-general-correctness-r1",
            "lens-general-intent-r1",
            "lens-general-tests-r1",
            "lens-general-design-r1"
        ]
    );
}

#[test]
fn a_metrics_lens_that_could_not_look_caps_the_verdict_at_warning_not_incomplete() {
    let (repo, out) = (typescript(), tempfile::tempdir().unwrap());
    let run = out.path().join("run");
    let graphs = tempfile::tempdir().unwrap();
    let (tool, _) = common::cbm::stand_in(graphs.path(), repo.path());
    let mut s = planned(
        repo.path(),
        out.path(),
        (Some(&tool), &out.path().join("unused")),
    );
    while s["done"] == json!(false) {
        let answers: serde_json::Map<String, Value> = ids(&s)
            .into_iter()
            .map(|id| {
                let name = id.strip_prefix("lens-general-").unwrap();
                let name = name.split('-').next().unwrap().to_owned();
                let mut a = lens(&name, &[]);
                if name == "complexity" {
                    a["blocked"] = json!({"couldNotLook": true, "what": "no graph tools"});
                }
                (id, a)
            })
            .collect();
        s = submit(&run, Value::Object(answers));
    }
    assert_eq!(s["verdict"], json!("Warning"), "{s}");
    // The finished step and the status name the gap in `capped`, as the run's record files it,
    // and leave `notRun` to what the review needed.
    let st = craft_review::status::status(&run).unwrap();
    for (what, v) in [("finished", &s), ("status", &st)] {
        assert_eq!(v["notRun"], json!([]), "{what}: {v}");
        assert_contains_all(
            &v["capped"].to_string(),
            &[
                "general metrics-only lenses that never returned — complexity:",
                "a coverage gap",
            ],
        );
    }
    let report = std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap();
    assert_contains_all(
        &report,
        &[
            "a coverage gap holds it at Warning, never Approve: general metrics-only lenses that never returned — complexity:",
            "no graph tools",
        ],
    );
    assert!(!report.contains("INCOMPLETE"), "{report}");
}
