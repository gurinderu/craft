use serde_json::json;

use super::{Look, look, look_gap, note, ready as lenses_run};
use crate::consumers::Measured;
use crate::prompts::PromptContext;

/// Whether the lenses run and the note when they do not, as the plan reads them; `None` when no
/// profile taking part wants them.
fn indexed(ctx: &PromptContext, wanted: bool) -> Option<(bool, Option<String>)> {
    let l = look(ctx);
    wanted.then(|| (lenses_run(l.as_ref()), note(ctx, l.as_ref())))
}

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
    assert_eq!(indexed(&ctx, true), Some((false, None)));
    let gap = look_gap(&look(&ctx).unwrap()).unwrap();
    assert!(gap.contains("the graph said boom"), "{gap}");
}

/// A context whose index is ready under craft's project.
fn ready() -> PromptContext {
    let mut ctx = PromptContext {
        graph_project: "craft-review-x".into(),
        ..PromptContext::default()
    };
    ctx.consumers.graph_indexed = true;
    ctx
}

#[test]
fn a_failed_read_is_a_lens_that_could_not_look_named_once_as_a_gap() {
    let mut ctx = ready();
    ctx.consumers.metrics_failed =
        "the graph's budget ran out before the numbers of the functions the change touches were read".into();
    // A move during the read unsets the index; the read's own reason still stands.
    ctx.consumers.graph_indexed = false;
    let look = look(&ctx).unwrap();
    let gap = look_gap(&look).unwrap();
    // The gap reads back as its key, the same every run, and its run's detail.
    assert_eq!(
        craft_store::gap::key(&gap),
        "metrics-only lens complexity could not look"
    );
    let (_, detail) = gap.split_once(craft_store::gap::SEP).unwrap();
    assert!(
        detail.starts_with("the graph's numbers could not be read (the graph's budget"),
        "{detail}"
    );
    assert!(
        gap.contains("could not look") && gap.contains("budget ran out"),
        "{gap}"
    );
    assert_eq!(
        indexed(&ctx, true),
        Some((false, None)),
        "no second note beside the gap"
    );
}

#[test]
fn every_file_unread_with_nothing_measured_could_not_look_and_names_the_files() {
    let mut ctx = ready();
    ctx.consumers.metrics_unread =
        vec!["src/a.rs (1 of its rows did not read as a function)".into()];
    ctx.consumers.metrics_empty = vec!["src/types.rs".into()];
    let gap = look_gap(&look(&ctx).unwrap()).unwrap();
    assert!(
        gap.contains("src/a.rs (1 of its rows did not read") && !gap.contains("src/types.rs"),
        "{gap}"
    );
    assert!(!gap.contains("no changed file's numbers read"), "{gap}");
}

#[test]
fn a_partly_unread_change_is_measured_and_no_gap() {
    let mut ctx = ready();
    ctx.consumers.metrics = vec![measured("src/a.rs", "f")];
    ctx.consumers.metrics_unread = vec!["src/b.rs (its functions cut at 500)".into()];
    assert_eq!(look(&ctx), Some(Look::Measured));
    assert_eq!(look_gap(&Look::Measured), None);
    assert_eq!(indexed(&ctx, true), Some((true, None)));
}

#[test]
fn files_that_answered_no_function_leave_nothing_to_judge_and_no_gap() {
    let mut ctx = ready();
    ctx.consumers.metrics_empty = vec!["src/types.rs".into()];
    let look = look(&ctx).unwrap();
    assert!(
        matches!(&look, Look::NothingToJudge(w) if w.contains("src/types.rs")),
        "{look:?}"
    );
    assert_eq!(look_gap(&look), None);
    let (ran, note) = indexed(&ctx, true).unwrap();
    assert!(!ran && note.unwrap().contains("nothing to judge"));
}

#[test]
fn a_gap_from_many_files_or_a_long_failure_is_one_bounded_line_that_keeps_its_count() {
    let mut ctx = ready();
    ctx.consumers.metrics_unread = (0..8)
        .map(|i| {
            format!(
                "src/m_{i}.rs (1 of its rows did not read as a function){}",
                "z".repeat(150)
            )
        })
        .collect();
    let gap = look_gap(&look(&ctx).unwrap()).unwrap();
    assert!(
        gap.contains("src/m_0.rs") && !gap.contains("src/m_5.rs"),
        "{gap}"
    );
    assert!(
        gap.ends_with(" +3 more"),
        "the count survives the cut: {gap}"
    );
    assert!(gap.chars().count() < 800, "{}", gap.chars().count());
    let mut ctx = ready();
    ctx.consumers.metrics_failed = format!("line one\nline two {}", "w".repeat(2000));
    let gap = look_gap(&look(&ctx).unwrap()).unwrap();
    assert!(
        !gap.contains('\n') && gap.contains("line one line two"),
        "{gap}"
    );
    assert!(
        gap.chars().count() < 800 && gap.ends_with("…)"),
        "{}",
        gap.chars().count()
    );
}
