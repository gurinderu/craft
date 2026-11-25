use std::collections::BTreeMap;
use std::path::PathBuf;

use super::*;

fn task(id: &str) -> Task {
    Task {
        id: id.into(),
        label: id.into(),
        model: "opus".into(),
        prompt_file: PathBuf::from("/p"),
        schema_file: PathBuf::from("/s"),
        answer_file: PathBuf::from("/a"),
        agent_type: None,
        consumer_agent: None,
        kind: None,
    }
}

#[test]
fn a_round_counts_what_ran_and_says_each_outcome() {
    let tasks: Vec<Task> = ["a", "b", "c", "d", "e"].into_iter().map(task).collect();
    let outcomes: BTreeMap<usize, Outcome> = [
        (0, Outcome::Abandoned),
        (
            1,
            Outcome::Unanswered {
                why: "x".into(),
                said: Some("boom".into()),
                wrote: Some("Insufficient Balance".into()),
            },
        ),
        (2, Outcome::Limit("hit your limit".into())),
        (3, Outcome::NotStarted),
        (4, Outcome::Login("no login".into())),
    ]
    .into_iter()
    .collect();
    let lines = std::cell::RefCell::new(Vec::new());
    let r = gather(&tasks, &outcomes, vec!["note".into()], &|l| {
        lines.borrow_mut().push(l.to_owned());
    });
    assert_eq!(r.abandoned, ["a"]);
    assert_eq!(r.errors, ["boom"]);
    assert_eq!(r.died, ["b=Insufficient Balance"]);
    assert_eq!(r.limit.as_deref(), Some("hit your limit"));
    assert_eq!(r.login.as_deref(), Some("no login"));
    assert_eq!(r.dispatched, 4);
    assert!(r.all_died);
    assert_eq!(r.degraded, ["note"]);
    assert!(
        lines
            .borrow()
            .iter()
            .any(|l| l.starts_with("⛔ usage limit reached"))
    );
}

#[test]
fn one_answer_keeps_the_round_alive() {
    let tasks = vec![task("a"), task("b")];
    let outcomes: BTreeMap<usize, Outcome> = [(0, Outcome::Answered), (1, Outcome::Abandoned)]
        .into_iter()
        .collect();
    assert!(!gather(&tasks, &outcomes, Vec::new(), &|_| {}).all_died);
}

/// A task whose agent wrote nothing tells the binary nothing, so the stop keeps its guess rather
/// than naming craft's own words (realm @nick/craft, node #666).
#[test]
fn a_task_whose_agent_wrote_nothing_is_not_said_to_have_died_of_anything() {
    let tasks = vec![task("a")];
    let outcomes: BTreeMap<usize, Outcome> = [(
        0,
        Outcome::Unanswered {
            why: "opencode gave no answer: ".into(),
            said: None,
            wrote: None,
        },
    )]
    .into_iter()
    .collect();
    let r = gather(&tasks, &outcomes, Vec::new(), &|_| {});
    assert!(r.all_died);
    assert!(r.died.is_empty(), "{:?}", r.died);
}
