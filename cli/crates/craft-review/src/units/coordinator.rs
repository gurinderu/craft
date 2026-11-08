//! The coordinator after the lens rounds (the engine's seam pass; realm @nick/craft, #315, #321):
//! one task per profile under unit mode, which answers the questions the confined lenses left in
//! their answers, decides each finding that depends on one — confirmed, dropped, or turned into a
//! seam finding — and judges the seam between the units. Its answer reaches the pool before the
//! dedup and verification. The engine's live coordinator, which answers a lens mid-round through
//! files in the run directory, is not ported (#321; see `crate::prompts::units`).

use serde_json::{Map, Value};

use super::{Seam, UnitTrack, seam};
use crate::content::{self, ContentError};
use crate::profile::Profile;
use crate::prompts;
use crate::rounds::key;
use crate::state::{RunState, Task, TaskKind, TaskState};

/// The questions no lens got an answer to.
fn open_questions(track: &UnitTrack) -> Vec<Value> {
    track
        .questions
        .iter()
        .filter(|q| q.get("answered") != Some(&Value::Bool(true)))
        .cloned()
        .collect()
}

/// The coordinator of each profile under unit mode whose change touched a unit.
///
/// # Errors
/// When a prompt cannot be rendered or the schema read.
pub fn seam_tasks(run: &RunState, profiles: &[Profile]) -> Result<Vec<Task>, ContentError> {
    let mut out = Vec::new();
    for track in run.units.tracks.iter().filter(|t| !t.units.is_empty()) {
        let Some(p) = profiles.iter().find(|p| p.id == track.profile) else {
            continue;
        };
        let (Some(words), Some(plan)) = (p.units.as_ref(), run.plan_of(&p.id)) else {
            continue;
        };
        let open = open_questions(track);
        out.push(Task::new(
            format!("seam-{}", p.id),
            format!("seam:{}", p.id),
            prompts::seam_prompt(
                &run.context,
                p,
                words,
                &track.units,
                &open,
                &plan.repo_rules,
            )?,
            plan.lens_model(p),
            content::schema("seam")?,
            TaskKind::Seam {
                profile: p.id.clone(),
            },
        ));
    }
    Ok(out)
}

/// Takes each coordinator's answer: its dispositions applied to the pool, its seam findings pooled
/// as `seam`; one with no valid answer is named as not run.
pub fn seam_answered(run: &mut RunState) {
    let tasks = std::mem::take(&mut run.tasks);
    for t in &tasks {
        let TaskKind::Seam { profile } = &t.kind else {
            continue;
        };
        let answer = t.answer.as_ref().filter(|_| t.state == TaskState::Answered);
        let Some((a, found)) = answer.and_then(|a| Some((a, a.get("findings")?.as_array()?)))
        else {
            run.not_run.push(format!(
                "{profile} seam pass (unitScope) — returned no findings"
            ));
            continue;
        };
        let Some(track) = run.units.tracks.iter_mut().find(|u| u.profile == *profile) else {
            continue;
        };
        let dispositions = a
            .get("dispositions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let pool = std::mem::take(&mut run.rounds.pool);
        let (mut kept, counts, set_aside) =
            seam::apply(pool, &dispositions, &open_questions(track));
        for f in found {
            let mut f: Map<String, Value> = f.as_object().cloned().unwrap_or_default();
            f.insert("source".into(), Value::String("seam".into()));
            f.insert("profile".into(), Value::String(profile.clone()));
            f.insert("foundInRound".into(), Value::from(run.rounds.round));
            let f = Value::Object(f);
            if !kept.iter().any(|g| key(g) == key(&f)) {
                kept.push(f);
            }
        }
        run.rounds.pool = kept;
        track.seam = Some(Seam {
            findings: found.len(),
            answered: a.get("answered").and_then(Value::as_u64).unwrap_or(0),
            dispositions: counts,
            set_aside,
        });
    }
    run.tasks = tasks;
}
