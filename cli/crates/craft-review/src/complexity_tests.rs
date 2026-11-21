use super::indexed;
use crate::prompts::PromptContext;

#[test]
fn a_run_whose_graph_project_has_no_name_says_why_the_complexity_lens_did_not_run() {
    let mut ctx = PromptContext::default();
    ctx.consumers.graph_indexed = true;
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
