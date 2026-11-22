//! When the complexity lens has been able to look, end to end through the plan: numbers read run
//! it with no gap, an answer of no function leaves nothing to judge and no gap, and a read that
//! failed or read no file whole is a coverage gap that holds the verdict at Warning.

#![expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "the helpers of these tests fail loudly, like the tests they serve"
)]

mod common;

use std::path::Path;

use common::{fixture, git, ids, lens, opts, scout, submit};
use craft_review::step;
use serde_json::{Value, json};

/// A finished run over a TypeScript change whose code graph answers the metrics question with
/// `metrics` (shell; `None`: one function's numbers), every lens answering nothing.
fn finished(metrics: Option<&str>) -> Value {
    finished_probed(metrics, None)
}

/// [`finished_picking`], the scout picking complexity.
fn finished_probed(metrics: Option<&str>, probe: Option<&str>) -> Value {
    finished_picking(metrics, probe, &["complexity"])
}

/// [`finished`], the graph's probe for any function's numbers answered by `probe` when given and
/// the scout picking `picks`.
fn finished_picking(metrics: Option<&str>, probe: Option<&str>, picks: &[&str]) -> Value {
    let repo = fixture(false);
    let d = repo.path();
    std::fs::create_dir_all(d.join("web")).unwrap();
    std::fs::write(d.join("web/app.ts"), "export const f = () => 1\n").unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "feat: f"]);
    let out = tempfile::tempdir().unwrap();
    let graphs = tempfile::tempdir().unwrap();
    let (tool, _) = common::cbm::stand_in_answering(graphs.path(), d, (metrics, probe));
    let unused = out.path().join("unused");
    let o = common::cbm::with_profile(opts(d, out.path()), out.path(), (Some(&tool), &unused));
    step::start(&o).unwrap();
    let run = out.path().join("run");
    let mut s = submit(&run, json!({"scout-general": scout("medium", picks)}));
    while s["done"] == json!(false) {
        let answers: serde_json::Map<String, Value> = ids(&s)
            .into_iter()
            .map(|id| {
                let name = id
                    .strip_prefix("lens-general-")
                    .unwrap()
                    .split('-')
                    .next()
                    .unwrap();
                let name = name.to_owned();
                (id, lens(&name, &[]))
            })
            .collect();
        s = submit(&run, Value::Object(answers));
    }
    let _keep = (out.keep(), graphs.keep(), repo);
    s
}

fn report(s: &Value) -> String {
    std::fs::read_to_string(Path::new(s["report"].as_str().unwrap())).unwrap()
}

#[test]
fn numbers_read_run_the_lens_and_file_no_gap() {
    let s = finished(None);
    assert!(
        s["dimensions"].to_string().contains("general:complexity"),
        "the lens ran: {s}"
    );
    assert_eq!(s["verdict"], json!("Approve"), "{s}");
    assert_eq!(s.get("capped"), Some(&json!([])), "{s}");
}

/// An answer of no function, every column the question asks named.
const EMPTY: &str = r#"echo '{"columns":["f.name","f.start_line","f.end_line","f.cognitive","f.complexity","f.loop_depth","f.transitive_loop_depth","f.param_count","f.linear_scan_in_loop","f.alloc_in_loop","f.recursion_in_loop","f.unguarded_recursion"],"rows":[]}'"#;

#[test]
fn an_answer_of_no_function_from_a_graph_that_holds_numbers_leaves_nothing_to_judge() {
    let s = finished(Some(EMPTY));
    assert_eq!(s["verdict"], json!("Approve"), "{s}");
    assert_eq!(s["capped"], json!([]), "{s}");
    assert!(report(&s).contains("nothing to judge"), "{}", report(&s));
}

#[test]
fn an_answer_of_no_function_from_a_graph_holding_none_or_failing_the_probe_could_not_look() {
    for (probe, why) in [
        (
            r#"echo '{"columns":["f.name"],"rows":[]}'"#,
            "the graph holds no function numbers: its metric properties may have changed",
        ),
        (r#"echo '{"error":"probe boom"}'; exit 1"#, "probe boom"),
    ] {
        let s = finished_probed(Some(EMPTY), Some(probe));
        assert_eq!(s["verdict"], json!("Warning"), "{why}: {s}");
        let capped = s["capped"].to_string();
        assert!(
            capped.contains("could not look") && capped.contains(why),
            "{why}: {capped}"
        );
    }
}

#[test]
fn an_empty_answer_missing_a_column_could_not_look() {
    let s = finished(Some(
        r#"echo '{"columns":["f.name","f.start_line","f.end_line"],"rows":[]}'"#,
    ));
    assert_eq!(s["verdict"], json!("Warning"), "{s}");
    assert!(
        s["capped"]
            .to_string()
            .contains("names no column f.cognitive"),
        "{s}"
    );
}

#[test]
fn a_read_with_no_file_read_whole_or_a_failed_read_is_a_coverage_gap() {
    for (answer, why) in [
        (
            r#"echo '{"columns":["f.name","f.start_line","f.end_line"],"rows":[["f","x","1"]]}'"#,
            "web/app.ts (1 of its rows did not read as a function",
        ),
        (
            r#"echo '{"error":"boom"}'; exit 1"#,
            "the graph's numbers could not be read",
        ),
    ] {
        let s = finished(Some(answer));
        assert_eq!(s["verdict"], json!("Warning"), "{why}: {s}");
        let capped = s["capped"].to_string();
        assert!(
            capped.contains("could not look") && capped.contains(why),
            "{why}: {capped}"
        );
        let r = report(&s);
        let (_, after) = r.split_once("## Not run").unwrap();
        assert!(after.contains("could not look"), "{r}");
        let notes = after.split_once("## Notes").map_or("", |(_, n)| n);
        assert!(
            !notes.contains("complexity lens did not run"),
            "no note beside the gap: {r}"
        );
    }
}

#[test]
fn a_read_that_failed_files_no_gap_when_no_plan_would_run_the_lens() {
    let failed = r#"echo '{"error":"boom"}'; exit 1"#;
    let s = finished_picking(Some(failed), None, &["correctness"]);
    let saved = std::fs::read_to_string(craft_review::state::state_path(Path::new(
        s["run"].as_str().unwrap(),
    )))
    .unwrap();
    assert!(saved.contains("boom"), "the read did fail: {saved}");
    assert_eq!(s["capped"], json!([]), "{s}");
    assert_eq!(s["verdict"], json!("Approve"), "{s}");
}
