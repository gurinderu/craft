//! The note on a refused answer file left in place, and the save that keeps it.

use craft_step::{Aside, HandoffError, Model, TaskState, Unmoved};

use super::{pending, set_aside};
use crate::kind::AuditKind;
use crate::state::{Args, AuditState, Phase, STATE_VERSION, Task};

fn run(phase: Phase) -> AuditState {
    let kind = |batch| AuditKind::Lens {
        profile: "rust".into(),
        lens: "safety".into(),
        batch,
    };
    let live = Task::new(
        "live".into(),
        "l".into(),
        "p".into(),
        Model::Opus,
        serde_json::json!({}),
        kind(0),
    );
    let mut done = Task::new(
        "done".into(),
        "d".into(),
        "p".into(),
        Model::Opus,
        serde_json::json!({}),
        kind(1),
    );
    done.state = TaskState::Answered;
    AuditState {
        version: STATE_VERSION,
        cwd: "/r".into(),
        args: Args::default(),
        scout: crate::scout::Scouted::default(),
        phase,
        pass: 1,
        tasks: vec![done, live],
        degraded: Vec::new(),
        notes: Vec::new(),
        stopped: None,
    }
}

#[test]
fn only_a_pending_task_of_a_run_not_done_still_waits_for_its_file() {
    let s = run(Phase::Lens);
    assert_eq!(pending(&s, "live").map(|t| t.id.as_str()), Some("live"));
    assert!(pending(&s, "done").is_none() && pending(&s, "none").is_none());
    assert!(pending(&run(Phase::Done), "live").is_none());
    let u = Unmoved {
        id: "live".into(),
        known: false,
        error: HandoffError::UnsafeId("x".into()),
    };
    let note = craft_step::left::note(pending(&s, "live"), &u);
    assert!(
        note.ends_with("read again, it is taken as a new answer"),
        "{note}"
    );
}

/// A run directory whose refused `live` answer cannot be moved aside and whose state cannot be
/// saved; `None` where the modes do not bind this user (root).
#[cfg(unix)]
fn locked(s: &AuditState) -> Option<(tempfile::TempDir, Aside)> {
    use std::os::unix::fs::PermissionsExt;
    let d = tempfile::tempdir().unwrap();
    let answers = craft_step::handoff::answers_dir(d.path());
    std::fs::create_dir_all(&answers).unwrap();
    std::fs::write(answers.join("live.json"), "{}").unwrap();
    let mut aside = Aside::default();
    aside.mark(d.path(), &s.tasks[1]).unwrap();
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
fn a_failed_save_of_the_note_fails_only_while_a_pending_tasks_file_stays_and_the_run_goes_on() {
    let stop = || Some(craft_step::stop::limit("limit"));
    let cases = [
        (Phase::Lens, false, None, true),
        (Phase::Done, false, None, false),
        (Phase::Lens, true, None, false),
        (Phase::Lens, false, stop(), false),
    ];
    for (phase, settled, stopped, fails) in cases {
        let mut s = run(phase);
        let Some((d, aside)) = locked(&s) else { return };
        if settled {
            s.tasks[1].state = TaskState::Failed;
        }
        s.stopped = stopped.clone();
        let got = set_aside(d.path(), &mut s, aside);
        unlock(&d);
        assert_eq!(
            got.is_err(),
            fails,
            "{phase:?}, settled {settled}, stopped {stopped:?}"
        );
        assert_eq!(s.notes.len(), 1, "{phase:?}: noted all the same");
    }
}

#[test]
fn nothing_left_in_place_saves_nothing() {
    let d = tempfile::tempdir().unwrap();
    let mut s = run(Phase::Lens);
    set_aside(d.path(), &mut s, Aside::default()).unwrap();
    assert!(s.notes.is_empty() && !crate::state::state_path(d.path()).exists());
}
