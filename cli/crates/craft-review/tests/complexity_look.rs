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
    let repo = fixture(false);
    let d = repo.path();
    std::fs::create_dir_all(d.join("web")).unwrap();
    std::fs::write(d.join("web/app.ts"), "export const f = () => 1\n").unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "feat: f"]);
    let out = tempfile::tempdir().unwrap();
    let graphs = tempfile::tempdir().unwrap();
    let (tool, _) = common::cbm::stand_in_answering(graphs.path(), d, metrics);
    let unused = out.path().join("unused");
    let o = common::cbm::with_profile(opts(d, out.path()), out.path(), (Some(&tool), &unused));
    step::start(&o).unwrap();
    let run = out.path().join("run");
    let mut s = submit(
        &run,
        json!({"scout-general": scout("medium", &["complexity"])}),
    );
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
    assert_eq!(s["verdict"], json!("Approve"), "{s}");
    assert_eq!(s.get("capped"), Some(&json!([])), "{s}");
}

#[test]
fn an_answer_of_no_function_leaves_nothing_to_judge_and_no_gap() {
    let s = finished(Some(
        r#"echo '{"columns":["f.name","f.start_line","f.end_line"],"rows":[]}'"#,
    ));
    assert_eq!(s["verdict"], json!("Approve"), "{s}");
    assert_eq!(s["capped"], json!([]), "{s}");
    assert!(report(&s).contains("nothing to judge"), "{}", report(&s));
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
