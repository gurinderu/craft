//! What a critic's answer admits, as `refuseCriticNames` in `lib/review-critic.mjs` decides it: a
//! named lens outside the candidates is ignored; one of the optional pass is refused (it is bought
//! by an explicit `optional` request, which plans it, never by a model mid-run), and one the surface gate dropped
//! is refused (realm @nick/craft, node #102) — each said in a note as an uncovered surface — and
//! the rest run.

use serde_json::Value;

use super::{candidates, lens_task};
use crate::content::ContentError;
use crate::profile::Profile;
use crate::state::{RunState, Task, TaskKind, TaskState};

/// What a critic's answer says, read loosely: the lenses it named and its note.
fn named(answer: &Value) -> (Vec<String>, String) {
    let lenses = answer
        .get("missingLenses")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let note = answer
        .get("notes")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned();
    (lenses, note)
}

/// The lenses `profile`'s critic named that may run; each refused one said in `notes`.
fn admitted(
    p: &Profile,
    plan_dropped: &[String],
    named: &[String],
    notes: &mut Vec<String>,
) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for l in named {
        if out.contains(l) {
            continue;
        }
        if p.lens(l).is_some_and(|x| x.optional) {
            notes.push(format!("[{}] the completeness critic named the optional lens {l} as an uncovered surface for THIS diff — NOT dispatched (the optional pass is bought by an explicit request, not by a model mid-run)", p.id));
        } else if plan_dropped.contains(l) {
            notes.push(format!("[{}] the completeness critic named the surface-gated lens {l} as an uncovered surface for THIS diff — NOT dispatched (the diff does not touch the surface its defect class needs): a visible gap, not a clean pass", p.id));
        } else {
            out.push(l.clone());
        }
    }
    out
}

/// The lenses every critic of the run admitted, as tasks; its notes kept for the report and the
/// admitted lenses on the record. A critic that gave no valid answer adds nothing.
///
/// # Errors
/// When a lens prompt cannot be rendered or the findings schema read.
pub(crate) fn followups(
    run: &mut RunState,
    profiles: &[Profile],
) -> Result<Vec<Task>, ContentError> {
    let mut tasks = Vec::new();
    let mut notes = Vec::new();
    let mut gaps = Vec::new();
    let mut lenses_run = Vec::new();
    for t in &run.tasks {
        let TaskKind::Critic { profile } = &t.kind else {
            continue;
        };
        let (Some(p), Some(plan)) = (
            profiles.iter().find(|p| p.id == *profile),
            run.plan_of(profile),
        ) else {
            continue;
        };
        let Some(answer) = t.answer.as_ref().filter(|_| t.state == TaskState::Answered) else {
            let why = t.error.clone().unwrap_or_else(|| "no answer".into());
            notes.push(format!("the {profile} completeness critic gave no valid answer ({why}): no lens was added on its word"));
            continue;
        };
        let (lenses, note) = named(answer);
        if !note.is_empty() && note != "coverage complete" {
            gaps.push(note);
        }
        let open = candidates(p, plan);
        let named: Vec<String> = lenses.into_iter().filter(|l| open.contains(l)).collect();
        for lens in admitted(p, &plan.surface_dropped, &named, &mut notes) {
            tasks.push(lens_task(run, p, plan, &lens)?);
            lenses_run.push(format!("{profile}:{lens}"));
        }
    }
    run.critic.notes.extend(gaps);
    run.critic.lenses.extend(lenses_run);
    if !run.critic.lenses.is_empty() {
        notes.push(format!(
            "completeness critic → follow-up lenses: {}",
            run.critic.lenses.join(", ")
        ));
    }
    run.notes.extend(notes);
    Ok(tasks)
}
