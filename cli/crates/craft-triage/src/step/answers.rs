//! The answers a run's tasks hold, as its run reads them.

use craft_step::TaskState;
use craft_store::js::Js;

use crate::kind::TriageKind;
use crate::run::Answers;
use crate::state::Task;

/// The answers of a run's tasks: a task not handed out yet is not asked, one that failed gave
/// none.
pub(super) struct TaskAnswers<'a>(pub &'a [Task]);

impl Answers for TaskAnswers<'_> {
    fn answer(&self, kind: &TriageKind) -> Option<Option<Js>> {
        let task = self.0.iter().find(|t| t.kind == *kind)?;
        match task.state {
            TaskState::Pending => None,
            TaskState::Failed => Some(None),
            TaskState::Answered => Some(task.answer.as_ref().map(Js::from)),
        }
    }
}
