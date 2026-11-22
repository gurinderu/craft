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

#[test]
fn a_read_that_failed_or_read_nothing_says_so_not_that_the_index_is_unavailable() {
    let mut ctx = PromptContext {
        graph_project: "craft-review-x".into(),
        ..PromptContext::default()
    };
    ctx.consumers.graph_indexed = true;
    ctx.consumers.metrics_failed =
        "the graph's budget ran out before the numbers of the functions the change touches were read".into();
    let (ran, note) = indexed(&ctx, true).unwrap();
    let note = note.unwrap();
    assert!(!ran);
    assert!(
        note.contains("the graph's budget ran out") && !note.contains("index is unavailable"),
        "{note}"
    );
    // Every changed file's numbers unread: the lens could not look, each file named.
    ctx.consumers.metrics_failed.clear();
    ctx.consumers.metrics_unread =
        vec!["src/a.rs (1 of its rows did not read as a function)".into()];
    let (ran, note) = indexed(&ctx, true).unwrap();
    let note = note.unwrap();
    assert!(!ran);
    assert!(
        note.contains("could not look") && note.contains("src/a.rs (1 of its rows did not read"),
        "{note}"
    );
    assert!(super::unread_gap(&ctx).is_some_and(|g| g.contains("src/a.rs")));
}
