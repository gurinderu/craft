//! Whether each judging lens read its rubric: a lens answers `rubricRead`, the files it read whole
//! with the Read tool. One whose prompt names a skill and whose answer names no `SKILL.md` may have
//! judged without its rubric — a partial `head` or no read at all — and the report names it as
//! degraded; the verdict stands, since what it found is still verified. A metrics lens judges from
//! the graph's numbers alone and is not asked.

use serde_json::Value;

use crate::profile::Profile;
use crate::state::{Task, TaskKind, TaskState};

/// The answer's field.
pub const FIELD: &str = "rubricRead";

/// Whether `answer` names a skill file it read whole.
fn read_one(answer: &Value) -> bool {
    answer
        .get(FIELD)
        .and_then(Value::as_array)
        .is_some_and(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .any(|p| p.trim().ends_with("SKILL.md"))
        })
}

/// The degraded note naming the answered lenses among `tasks` that read no rubric file whole;
/// `None` when each did.
#[must_use]
pub fn unread(tasks: &[Task], profiles: &[Profile]) -> Option<String> {
    let mut names = Vec::new();
    for t in tasks.iter().filter(|t| t.state == TaskState::Answered) {
        let (TaskKind::Lens { profile, lens, .. } | TaskKind::CriticLens { profile, lens }) =
            &t.kind
        else {
            continue;
        };
        let spec = profiles
            .iter()
            .find(|p| &p.id == profile)
            .and_then(|p| p.lens(lens));
        if spec.is_some_and(|l| l.metrics) || !crate::prompts::skills::names_skill(&t.prompt) {
            continue;
        }
        if !t.answer.as_ref().is_some_and(read_one) {
            names.push(t.label.clone());
        }
    }
    (!names.is_empty()).then(|| {
        format!(
            "{} lens task(s) named no rubric file they read whole (`{FIELD}`), so they may have \
             judged without their rubric: {}",
            names.len(),
            names.join(" · ")
        )
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::read_one;

    #[test]
    fn only_a_skill_file_read_whole_counts() {
        assert!(read_one(
            &json!({"rubricRead": ["/p/skills/rust-review/SKILL.md"]})
        ));
        assert!(!read_one(
            &json!({"rubricRead": ["/p/skills/rust-review/rules.md"]})
        ));
        assert!(!read_one(&json!({"rubricRead": []})));
        assert!(!read_one(&json!({"findings": []})));
    }
}
