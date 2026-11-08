//! Unit mode's tasks beside the lens rounds (`lib/review-unit-scope.mjs`): the contract lens of each
//! touched unit in the first round (realm @nick/craft, #327), and the questions the confined lenses
//! leave in their answers for the coordinator after the last round ([`super::coordinator`]).

use serde_json::{Map, Value};

use super::UnitTrack;
use crate::content::{self, ContentError};
use crate::plan::Plan;
use crate::profile::Profile;
use crate::prompts::{self, PromptContext};
use crate::state::{RunState, Task, TaskKind, TaskState};

/// The contract lens of each unit `track` touches, in the first round only.
///
/// # Errors
/// When a prompt cannot be rendered or the schema read.
pub fn contract_tasks(
    ctx: &PromptContext,
    profile: &Profile,
    plan: &Plan,
    track: &UnitTrack,
    round: u32,
    prior: &str,
) -> Result<Vec<Task>, ContentError> {
    let Some(words) = profile.units.as_ref().filter(|_| round == 1) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for (i, unit) in track.units.iter().enumerate() {
        let slice = format!("unit:{unit}");
        let mut task = Task::new(
            format!("lens-{}-contract-r{round}-u{i}", profile.id),
            format!("lens:{}:contract r{round} {slice}", profile.id),
            prompts::contract_prompt(ctx, profile, words, unit, prior, &plan.repo_rules)?,
            plan.lens_model(profile),
            content::schema("unit-findings")?,
            TaskKind::Lens {
                profile: profile.id.clone(),
                lens: "contract".into(),
                round,
                slice: Some(slice),
            },
        );
        task.agent_type = profile.lens_agent;
        out.push(task);
    }
    Ok(out)
}

/// The questions in the answers of a round's lens tasks, each kept with the lens that asked.
pub fn keep_questions(run: &mut RunState) {
    for t in run.tasks.iter().filter(|t| t.state == TaskState::Answered) {
        let TaskKind::Lens { profile, lens, .. } = &t.kind else {
            continue;
        };
        let Some(track) = run.units.tracks.iter_mut().find(|u| u.profile == *profile) else {
            continue;
        };
        let asked = t
            .answer
            .as_ref()
            .and_then(|a| a.get("questions"))
            .and_then(Value::as_array);
        for q in asked.into_iter().flatten() {
            let mut q: Map<String, Value> = q.as_object().cloned().unwrap_or_default();
            q.insert("lens".into(), Value::String(lens.clone()));
            track.questions.push(Value::Object(q));
        }
    }
}
