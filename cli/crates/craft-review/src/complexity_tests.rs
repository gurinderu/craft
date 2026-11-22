use serde_json::json;

use super::indexed;
use crate::consumers::Measured;
use crate::prompts::PromptContext;

/// A function of `file` the graph measured.
pub(crate) fn measured(file: &str, function: &str) -> Measured {
    Measured {
        function: function.into(),
        file: file.into(),
        start: 3,
        end: 9,
        metrics: json!({"cognitive": 24}).as_object().unwrap().clone(),
    }
}

#[test]
fn a_run_whose_graph_project_has_no_name_says_why_the_complexity_lens_did_not_run() {
    let mut ctx = PromptContext::default();
    ctx.consumers.graph_indexed = true;
    ctx.consumers.metrics = vec![measured("src/a.rs", "f")];
    let (ran, note) = indexed(&ctx, true).unwrap();
    assert!(!ran);
    assert!(
        note.as_deref()
            .is_some_and(|n| n.contains("did not run") && n.contains("could not be named")),
        "{note:?}"
    );
    ctx.graph_project = "craft-review-x".into();
    assert_eq!(indexed(&ctx, true), Some((true, None)));
    assert_eq!(indexed(&ctx, false), None);
}

#[test]
fn the_lens_runs_only_on_numbers_the_binary_read_itself() {
    let mut ctx = PromptContext {
        graph_project: "craft-review-x".into(),
        ..PromptContext::default()
    };
    ctx.consumers.graph_indexed = true;
    let (ran, note) = indexed(&ctx, true).unwrap();
    assert!(
        !ran,
        "an index with no measured function gives the lens nothing"
    );
    assert!(note.unwrap().contains("no function the change touches"));
    ctx.consumers.metrics = vec![measured("src/a.rs", "f")];
    ctx.consumers.metrics_failed = "the graph said boom".into();
    let (ran, note) = indexed(&ctx, true).unwrap();
    assert!(!ran);
    assert!(note.unwrap().contains("the graph said boom"));
}
