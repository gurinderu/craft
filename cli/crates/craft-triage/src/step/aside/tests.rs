//! The note on a refused answer file left in place, and the save that keeps it.

use craft_step::{Aside, Counted, HandoffError, Model, Unmoved};

use super::{set_aside, unmoved_note};
use crate::kind::TriageKind;
use crate::run::{Args, Phase};
use crate::state::{STATE_VERSION, Seen, Task, TriageState};

fn run(phase: Phase, counted: Option<bool>) -> TriageState {
    let mut t = Task::new(
        "plan".into(),
        "plan".into(),
        "p".into(),
        Model::Opus,
        serde_json::json!({}),
        TriageKind::Plan,
    );
    t.counted = counted.map(|again| Counted {
        print: "x".into(),
        at: 0,
        again,
    });
    let other = Task::new(
        "other".into(),
        "o".into(),
        "p".into(),
        Model::Opus,
        serde_json::json!({}),
        TriageKind::GatherPr,
    );
    let mut done = other;
    done.state = craft_step::TaskState::Answered;
    TriageState {
        version: STATE_VERSION,
        cwd: "/r".into(),
        args: Args::default(),
        phase,
        tasks: vec![done, t],
        seen: Seen::default(),
        degraded: Vec::new(),
        notes: Vec::new(),
    }
}

fn unmoved(id: &str, known: bool) -> Unmoved {
    Unmoved {
        id: id.into(),
        known,
        error: HandoffError::UnsafeId("x".into()),
    }
}

fn then(s: &TriageState, u: &Unmoved) -> String {
    unmoved_note(s, u).rsplit("); ").next().unwrap().to_owned()
}

#[test]
fn the_note_says_what_the_next_read_of_the_file_does() {
    let live = run(Phase::Plan, None);
    assert_eq!(
        then(&live, &unmoved("plan", false)),
        "read again, it is taken as a new answer"
    );
    assert!(
        then(&live, &unmoved("plan", true)).starts_with("read again, it is set aside uncounted")
    );
    let again = run(Phase::Plan, Some(true));
    assert!(
        then(&again, &unmoved("plan", true))
            .starts_with("found there again after a round that ran")
    );
    let once = run(Phase::Plan, Some(false));
    assert!(
        then(&once, &unmoved("plan", true)).starts_with("read again, it is set aside uncounted")
    );
    assert_eq!(
        then(&live, &unmoved("other", false)),
        "its task is settled, so it stays there"
    );
    assert_eq!(
        then(&run(Phase::Done, None), &unmoved("plan", false)),
        "its task is settled, so it stays there"
    );
    assert!(
        unmoved_note(&live, &unmoved("plan", false))
            .starts_with("plan: a refused answer file left in place (task id")
    );
}

/// A run directory whose refused `plan` answer cannot be moved aside and whose state cannot
/// be saved; `None` where the modes do not bind this user (root).
#[cfg(unix)]
fn locked() -> Option<(tempfile::TempDir, Aside)> {
    use std::os::unix::fs::PermissionsExt;
    let d = tempfile::tempdir().unwrap();
    let answers = craft_step::handoff::answers_dir(d.path());
    std::fs::create_dir_all(&answers).unwrap();
    std::fs::write(answers.join("plan.json"), "{}").unwrap();
    let mut aside = Aside::default();
    aside
        .mark(d.path(), &run(Phase::Plan, None).tasks[1])
        .unwrap();
    for p in [&answers, &d.path().to_path_buf()] {
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o555)).unwrap();
    }
    let bound = std::fs::write(d.path().join("probe"), "").is_err();
    bound.then_some((d, aside))
}

#[cfg(unix)]
fn unlock(d: &tempfile::TempDir) {
    use std::os::unix::fs::PermissionsExt;
    for p in [
        craft_step::handoff::answers_dir(d.path()),
        d.path().to_path_buf(),
    ] {
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}

#[cfg(unix)]
#[test]
fn a_failed_save_of_the_note_fails_a_live_run_and_is_let_go_once_it_is_done() {
    for (phase, fails) in [(Phase::Plan, true), (Phase::Done, false)] {
        let Some((d, aside)) = locked() else { return };
        let mut s = run(phase, None);
        let got = set_aside(d.path(), &mut s, aside);
        unlock(&d);
        assert_eq!(got.is_err(), fails, "{phase:?}");
        assert_eq!(s.notes.len(), 1, "{phase:?}: noted all the same");
    }
}
