//! The note on each file left in place and when a failed save of the notes fails the step.

use super::{chain, left, note};
use crate::handoff::{HandoffError, Unmoved};
use crate::task::Counted;
use crate::test_kind::task;

fn unmoved(id: &str, known: bool) -> Unmoved {
    let io = std::io::Error::other("disk full");
    let error = HandoffError::Unmovable {
        path: "/run/answers/a.json".into(),
        source: io,
    };
    Unmoved {
        id: id.into(),
        known,
        error,
    }
}

fn then(n: &str) -> &str {
    n.rsplit("; ").next().unwrap()
}

#[test]
fn the_note_says_what_the_next_read_of_the_file_does() {
    let mut t = task();
    assert_eq!(
        then(&note(Some(&t), &unmoved("a", false))),
        "read again, it is taken as a new answer"
    );
    assert!(
        then(&note(Some(&t), &unmoved("a", true)))
            .starts_with("read again, it is set aside uncounted")
    );
    t.counted = Some(Counted {
        print: "p".into(),
        at: 0,
        again: true,
    });
    assert!(
        then(&note(Some(&t), &unmoved("a", true)))
            .starts_with("found there again after a round that ran")
    );
    t.counted = Some(Counted {
        print: "p".into(),
        at: 0,
        again: false,
    });
    assert!(
        then(&note(Some(&t), &unmoved("a", true)))
            .starts_with("read again, it is set aside uncounted")
    );
    assert_eq!(
        then(&note::<crate::test_kind::Plain>(None, &unmoved("a", false))),
        "its task is settled, so it stays there"
    );
}

#[test]
fn the_note_names_the_error_with_its_cause() {
    let n = note(Some(&task()), &unmoved("a", false));
    assert!(
        n.starts_with("moving /run/answers/a.json aside: disk full: left in place; "),
        "{n}"
    );
    assert_eq!(
        chain(&unmoved("a", false).error),
        "moving /run/answers/a.json aside: disk full"
    );
}

#[test]
fn only_a_pending_tasks_file_left_in_place_makes_a_failed_save_fail_the_step() {
    let t = task();
    let files = [unmoved("a", false), unmoved("b", false)];
    let (notes, goes_on) = left(&files, |id| (id == "b").then_some(&t));
    assert_eq!(notes.len(), 2);
    assert!(goes_on);
    assert!(
        notes[0].ends_with("its task is settled, so it stays there"),
        "{notes:?}"
    );
    let (_, settled) = left::<crate::test_kind::Plain>(&files, |_| None);
    assert!(!settled);
}
