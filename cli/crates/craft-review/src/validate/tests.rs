//! A lens answer must mark every CONSUMERS line its prompt listed.

use serde_json::{Value, json};

use super::{check, listed};
use crate::agent::Model;
use crate::consumers::{Consumers, Listed, Site, lens_block};
use crate::content;
use crate::state::{Task, TaskKind};

fn lens(consumers: &[&str]) -> Task {
    let mut t = Task::new(
        "lens-rust-correctness-r1".into(),
        "l".into(),
        "p".into(),
        Model::Opus,
        content::schema("findings").unwrap(),
        TaskKind::Lens {
            profile: "rust".into(),
            lens: "correctness".into(),
            round: 1,
            slice: None,
        },
    );
    t.consumers = consumers.iter().map(|s| (*s).to_owned()).collect();
    t
}

fn answer(marked: &[&str]) -> Value {
    let marks: Vec<Value> = marked
        .iter()
        .map(|s| json!({"site": s, "status": "checked"}))
        .collect();
    json!({"lens": "correctness", "findings": [], "consumers": marks})
}

#[test]
fn a_lens_answer_that_leaves_consumer_lines_unmarked_is_asked_again_naming_them() {
    let t = lens(&["src/a.rs:3", "src/b.rs:5", "src/c.rs:9"]);
    let Err(why) = check(&t, Some(&answer(&["src/a.rs:3"])), false) else {
        panic!("an answer leaving consumer lines unmarked was taken");
    };
    assert!(
        why.contains("src/b.rs:5") && why.contains("src/c.rs:9"),
        "{why}"
    );
    assert!(!why.contains("src/a.rs:3"), "{why}");
}

#[test]
fn on_its_last_attempt_an_answer_leaving_lines_unmarked_is_taken_naming_them() {
    let t = lens(&["src/a.rs:3", "src/b.rs:5"]);
    let (taken, left) = check(&t, Some(&answer(&["src/a.rs:3"])), true).unwrap();
    assert_eq!(taken["lens"], json!("correctness"));
    assert_eq!(left, ["src/b.rs:5"]);
    // Only the unmarked lines are forgiven: an answer off its schema is still refused.
    let off = json!({"lens": "correctness"});
    check(&t, Some(&off), true).unwrap_err();
}

#[test]
fn a_lens_answer_marking_every_listed_line_is_taken() {
    let t = lens(&["src/a.rs:3", "src/b.rs:5"]);
    let a = answer(&["src/b.rs:5", "src/a.rs:3", "src/z.rs:1"]);
    check(&t, Some(&a), false).unwrap();
}

#[test]
fn a_lens_shown_no_consumer_lines_needs_no_marks() {
    let a = json!({"lens": "correctness", "findings": []});
    check(&lens(&[]), Some(&a), false).unwrap();
}

fn site(file: &str, line: u32) -> Site {
    Site {
        file: file.into(),
        line,
        text: "k8s_rule_to_api(1)".into(),
        from: vec!["name search".into()],
        kind: String::new(),
    }
}

/// A list of one symbol named on `src/a.rs:1`, `src/a.rs:12` and `src/b.rs:4`.
fn list() -> Consumers {
    Consumers {
        sources: vec!["name search".into()],
        symbols: vec![Listed {
            name: "k8s_rule_to_api".into(),
            file: "src/lib.rs".into(),
            line: 1,
            sites: vec![
                site("src/a.rs", 1),
                site("src/a.rs", 12),
                site("src/b.rs", 4),
            ],
        }],
        ..Consumers::default()
    }
}

#[test]
fn the_lines_a_lens_must_mark_are_those_its_prompt_lists() {
    let c = list();
    let block = lens_block(&c).unwrap();
    assert_eq!(
        listed(&format!("intro\n{block}\nrest"), &c),
        ["src/a.rs:1", "src/a.rs:12", "src/b.rs:4"]
    );
    // A prompt shown part of the list is held to that part, a line's prefix never matching
    // another's.
    let part = block.replace("- src/a.rs:1: ", "- elsewhere: ");
    assert_eq!(listed(&part, &c), ["src/a.rs:12", "src/b.rs:4"]);
    assert!(listed("a prompt with no CONSUMERS block", &c).is_empty());
}
