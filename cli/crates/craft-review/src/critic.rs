//! The completeness critic, as `criticPhase` in `integrations/shared/review-critic.mjs` runs it: once the pool is
//! verified, a profile whose plan is large or security-sensitive asks one critic which lenses of
//! its roster that did not run should have; each it names runs once, unless the optional pass or
//! the surface gate refuses it (said in a note, never dispatched); what those lenses find that the
//! pool does not hold is deduplicated and verified like the rest. A light pass runs no critic
//! (realm @nick/craft, node #295). The engine's budget gate has no counterpart: the CLI keeps no
//! token budget, as the engine skips the gate when it has none.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::agent::Model;
use crate::content::{self, ContentError};
use crate::plan::Plan;
use crate::profile::Profile;
use crate::prompts::{self, CriticIn, LensIn};
use crate::rounds::key;
use crate::settle::Tier;
use crate::state::{RunState, Task, TaskKind, TaskState, finding_profile};

mod admit;
#[cfg(test)]
mod marks_tests;
#[cfg(test)]
mod tests;

pub(crate) use admit::followups;

/// Where the critic stands in a run.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Stage {
    /// Not asked yet.
    #[default]
    Before,
    /// Asked, or its lenses dispatched.
    Asked,
    /// Its lenses' findings are being deduplicated and verified.
    Verifying,
    Done,
}

/// The critic's part of a run.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Critic {
    pub stage: Stage,
    /// What verification settled before the critic's lenses ran, kept while theirs is verified.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub settled_before: Vec<Value>,
    /// Each critic's line on what else was likely missed, `coverage complete` left out.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
    /// The lenses it admitted, each as `profile:lens`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub lenses: Vec<String>,
}

/// Whether the plan calls for a critic: a large diff, or a security-sensitive one.
fn in_scope(plan: &Plan) -> bool {
    plan.size_bucket == "large" || plan.security_sensitive
}

/// The lenses a critic may name: the roster's that the plan did not run. A metrics-or-nothing lens
/// is no candidate while the run's code-metrics index is not ready (`metrics`), picked or not:
/// nothing it would read is there.
pub(crate) fn candidates(profile: &Profile, plan: &Plan, metrics: bool) -> Vec<String> {
    let no_index = profile.flagged(|l| l.metrics && !metrics);
    profile
        .roster()
        .into_iter()
        .filter(|l| {
            !plan.lenses.contains(l) && !plan.metrics_dropped.contains(l) && !no_index.contains(l)
        })
        .collect()
}

/// Whether the run's code-metrics index is ready, as the plan judged it ([`crate::complexity`]).
pub(crate) fn metrics_ready(run: &RunState) -> bool {
    crate::complexity::indexed(&run.context, true).is_some_and(|(ready, _)| ready)
}

/// One critic per profile whose plan calls for it and has a lens left to name; none on a light pass.
///
/// # Errors
/// When a prompt cannot be rendered or the critic schema read.
pub(crate) fn tasks(run: &RunState, profiles: &[Profile]) -> Result<Vec<Task>, ContentError> {
    if run.light {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for (track, p) in run.tracks.iter().zip(profiles) {
        let Some(plan) = track.plan.as_ref().filter(|plan| in_scope(plan)) else {
            continue;
        };
        let candidates = candidates(p, plan, metrics_ready(run));
        if candidates.is_empty() {
            continue;
        }
        let tier = |want: Tier| {
            run.settled
                .iter()
                .filter(|f| finding_profile(run, f) == p.id && Tier::of(f) == want)
                .count()
        };
        let at = CriticIn {
            lang: &p.lang,
            lenses: &plan.lenses,
            confirmed: tier(Tier::Confirmed),
            suspected: tier(Tier::Suspected),
            candidates: &candidates,
        };
        out.push(Task::new(
            format!("critic-{}", p.id),
            format!("critic:{}", p.id),
            prompts::critic_prompt(&run.context, &at)?,
            Model::Opus,
            content::schema("critic")?,
            TaskKind::Critic {
                profile: p.id.clone(),
            },
        ));
    }
    Ok(out)
}

/// The task of `lens`, admitted by `profile`'s critic, told how many findings the earlier lenses
/// of its profile produced.
fn lens_task(run: &RunState, p: &Profile, plan: &Plan, lens: &str) -> Result<Task, ContentError> {
    let pooled = run
        .rounds
        .pool
        .iter()
        .filter(|f| finding_profile(run, f) == p.id)
        .count();
    let prior = prompts::critic_prior(pooled)?;
    let track = run.track(&p.id).map_or(&[][..], |t| t.files.as_slice());
    let pathspec = run.context.pathspec(p, track);
    let at = LensIn {
        profile: p,
        lens,
        plan,
        pathspec: &pathspec,
        prior: &prior,
    };
    let mut task = Task::new(
        format!("critic-lens-{}-{lens}", p.id),
        format!("lens:{}:{lens} (critic)", p.id),
        prompts::lens_prompt(&run.context, &at)?,
        p.lens(lens).map_or(Model::Opus, |l| l.model),
        content::schema("findings")?,
        TaskKind::CriticLens {
            profile: p.id.clone(),
            lens: lens.to_owned(),
        },
    );
    task.agent_type = p.agent_of(lens);
    task.marks.consumers = crate::validate::listed(&task.prompt, &run.context.consumers);
    Ok(task)
}

/// What the admitted lenses found that the pool does not hold, each once, its `source` the lens
/// and its `profile` the critic's; each lens that gave no findings is named in `not_run`, a
/// metrics-only one in `capped`, as the rounds name theirs. The CONSUMERS lines each lens was
/// shown are noted as the rounds note a lens's.
pub(crate) fn fresh(run: &mut RunState, profiles: &[Profile]) -> Vec<Value> {
    let mut seen: Vec<String> = run.rounds.pool.iter().map(key).collect();
    let mut out = Vec::new();
    for t in &run.tasks {
        let TaskKind::CriticLens { profile, lens } = &t.kind else {
            continue;
        };
        let found = t
            .answer
            .as_ref()
            .filter(|_| t.state == TaskState::Answered)
            .and_then(|a| a.get("findings"))
            .and_then(Value::as_array);
        run.rounds.note_lines(t, found.is_some());
        let Some(found) = found else {
            let gap = profiles
                .iter()
                .any(|p| &p.id == profile && p.metrics_only(lens));
            if gap {
                run.capped.push(crate::gaps::critic_dead(profile, lens));
            } else {
                let why = crate::gaps::CRITIC_DEAD;
                run.not_run
                    .push(format!("{profile} critic follow-up lens {lens} — {why}"));
            }
            continue;
        };
        for f in found {
            let mut f = f.as_object().cloned().unwrap_or_default();
            f.insert("source".into(), Value::String(lens.clone()));
            f.insert("profile".into(), Value::String(profile.clone()));
            f.insert("foundBy".into(), Value::from("critic"));
            let f = Value::Object(f);
            let k = key(&f);
            if !seen.contains(&k) {
                seen.push(k);
                out.push(f);
            }
        }
    }
    out
}

/// The tasks of the critic's verification pass under ids of their own: the first pass's answer
/// files stay where they are, and an id reused would read them.
pub(crate) fn relabel(run: &RunState, tasks: &mut [Task]) {
    if run.critic.stage != Stage::Verifying {
        return;
    }
    for t in tasks.iter_mut().filter(|t| !t.id.starts_with("critic-")) {
        t.id = format!("critic-{}", t.id);
    }
}

/// The report's account of what the critics said beyond their lenses, verbatim, as review.js's
/// `## Coverage gaps`; empty when none said anything.
#[must_use]
pub fn section(run: &RunState) -> String {
    if run.critic.notes.is_empty() {
        return String::new();
    }
    format!("\n## Coverage gaps\n\n{}\n", run.critic.notes.join(" · "))
}
