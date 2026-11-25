//! The run moved on: derived again from its answers and the scopes git observed, its next phase's
//! tasks handed out, or its end.

use crate::TriageError;
use crate::run::Phase;
use crate::run::{Finished, Progress, run};
use crate::state::{Task, TriageState};

use super::answers::TaskAnswers;

/// The run derived from its answers: the next phase's tasks handed out, or the finished run.
pub(super) fn advance(s: &mut TriageState) -> Result<Option<Finished>, TriageError> {
    let progress = {
        let answers = TaskAnswers(&s.tasks);
        let seen = std::cell::RefCell::new(s.seen.clone());
        let repo = s.cwd.clone();
        let p = run(&s.args, &answers, &|ds| seen.borrow_mut().scope(&repo, ds))?;
        s.seen = seen.into_inner();
        p
    };
    match progress {
        Progress::Asks(phase, asks) => {
            s.phase = phase;
            let before = s.tasks.len();
            let fresh: Vec<crate::run::Ask> = asks
                .into_iter()
                .filter(|a| !s.tasks.iter().any(|t| t.kind == a.kind))
                .collect();
            for a in fresh {
                s.tasks.push(Task::new(
                    a.id, a.label, a.prompt, a.model, a.schema, a.kind,
                ));
            }
            if s.tasks.len() == before {
                return Err(TriageError::Stuck(phase));
            }
            Ok(None)
        }
        Progress::Done(done) => {
            s.phase = Phase::Done;
            Ok(Some(*done))
        }
    }
}
