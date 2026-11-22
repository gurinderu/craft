//! The CONSUMERS lines no lens was shown: confined lenses withhold the lines outside their units,
//! which only the seam pass, marking nothing per line, then reads; and those shown only to lenses
//! that did not answer.

use serde_json::json;

use super::Rounds;
use crate::agent::Model;
use crate::state::{Task, TaskKind, TaskState};

fn shown(lens: &str, consumers: &[&str], answered: bool) -> Task {
    let mut t = Task::new(
        format!("lens-rust-{lens}-r1"),
        "l".into(),
        "p".into(),
        Model::Opus,
        json!({}),
        TaskKind::Lens {
            profile: "rust".into(),
            lens: lens.into(),
            round: 1,
            slice: Some("crates/a".into()),
        },
    );
    t.marks.consumers = consumers.iter().map(|s| (*s).to_owned()).collect();
    if answered {
        t.state = TaskState::Answered;
        t.answer = Some(json!({"findings": []}));
    } else {
        t.state = TaskState::Failed;
    }
    t
}

#[test]
fn a_line_shown_to_no_lens_is_named_and_one_a_dead_lens_was_shown_is_not() {
    let mut r = Rounds {
        round: 1,
        ..Rounds::default()
    };
    r.absorb(&[
        shown("errors", &["crates/a/x.rs:1"], true),
        shown("intent", &["crates/a/y.rs:2"], false),
    ]);
    let listed = ["crates/a/x.rs:1", "crates/a/y.rs:2", "tools/z.rs:3"].map(str::to_owned);
    assert_eq!(r.unshown(&listed), ["tools/z.rs:3"]);
    assert_eq!(r.unanswered(), ["crates/a/y.rs:2"]);
}

#[test]
fn a_line_an_answered_lens_marked_or_left_is_not_named_as_shown_only_to_dead_lenses() {
    let mut r = Rounds::default();
    let mut left = shown("errors", &["a.rs:1", "b.rs:2"], true);
    left.marks.unmarked = vec!["b.rs:2".into()];
    r.absorb(&[
        shown("intent", &["a.rs:1", "b.rs:2", "c.rs:3"], false),
        left,
    ]);
    assert_eq!(r.unanswered(), ["c.rs:3"]);
    assert_eq!(r.unmarked(), ["b.rs:2"]);
    assert!(!r.consumers_marked.contains(&"c.rs:3".to_owned()));
}

#[test]
fn the_lines_a_cut_short_copy_absorbed_are_taken_shown_marked_and_left() {
    let mut run = Rounds::default();
    let mut copy = run.clone();
    let mut left = shown("errors", &["a.rs:1", "b.rs:2"], true);
    left.marks.unmarked = vec!["b.rs:2".into()];
    copy.absorb(&[left, shown("intent", &["c.rs:3"], false)]);
    copy.pool = vec![json!({"title": "kept"})];
    let pool = run.take_consumers(copy);
    assert_eq!(pool, [json!({"title": "kept"})]);
    assert_eq!(run.consumers_shown, ["a.rs:1", "b.rs:2", "c.rs:3"]);
    assert_eq!(run.unanswered(), ["c.rs:3"]);
    assert_eq!(run.consumers_marked, ["a.rs:1"]);
    assert_eq!(run.unmarked(), ["b.rs:2"]);
}
