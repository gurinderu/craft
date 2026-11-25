//! The refused answer files moved aside once the state counting their refusal is saved, as the
//! review moves its own (`set_aside` and `unmoved_note` in `craft-review`'s step): one that cannot
//! be moved stays where its agent wrote it, and the run notes what its next read does.

use std::path::Path;

use craft_step::{Aside, Unmoved, take};

use crate::TriageError;
use crate::run::Phase;
use crate::state::{self, TriageState};

/// The note on a refused answer file `u` left in place, saying what its next read does.
fn unmoved_note(s: &TriageState, u: &Unmoved) -> String {
    let pending = s
        .tasks
        .iter()
        .find(|t| t.id == u.id)
        .filter(|t| s.phase != Phase::Done && t.pending());
    let then = match pending {
        None => "its task is settled, so it stays there",
        Some(_) if !u.known => "read again, it is taken as a new answer",
        Some(t) if t.counted.as_ref().is_some_and(|c| c.again) => {
            "found there again after a round that ran, it counts as a missing answer"
        }
        Some(_) => {
            "read again, it is set aside uncounted, and found there once more after a round that ran it counts as a missing answer"
        }
    };
    format!(
        "{}: a refused answer file left in place ({}); {then}",
        u.id,
        craft_review::sources::chain(&u.error)
    )
}

/// Moves the refused answers aside, notes each it could not move and saves the run again. Once the
/// run is done the note is information alone: a failed save of it is let go, so the finished step
/// is still returned.
///
/// # Errors
/// When that save fails while the run goes on.
pub(super) fn set_aside(dir: &Path, s: &mut TriageState, aside: Aside) -> Result<(), TriageError> {
    let unmoved = aside.apply();
    if unmoved.is_empty() {
        return Ok(());
    }
    let notes: Vec<String> = unmoved.iter().map(|u| unmoved_note(s, u)).collect();
    take::note(&mut s.notes, &notes);
    match state::save(dir, s) {
        Err(e) if s.phase != Phase::Done => Err(e.into()),
        Ok(()) | Err(_) => Ok(()),
    }
}

#[cfg(test)]
mod tests {
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
            then(&live, &unmoved("plan", true))
                .starts_with("read again, it is set aside uncounted")
        );
        let again = run(Phase::Plan, Some(true));
        assert!(
            then(&again, &unmoved("plan", true))
                .starts_with("found there again after a round that ran")
        );
        let once = run(Phase::Plan, Some(false));
        assert!(
            then(&once, &unmoved("plan", true))
                .starts_with("read again, it is set aside uncounted")
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
}
