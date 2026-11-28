//! The run moved on: a pass's lens agents handed out, then the verifiers of what they found, then
//! its end.

use craft_review::profile::Profile;
use craft_step::Model;

use crate::AuditError;
use crate::kind::AuditKind;
use crate::plan;
use crate::pool;
use crate::prompts;
use crate::state::{AuditState, Phase, Task};

/// Hands out the lens agents the pass `s.pass` buys of the jobs no task answered yet.
///
/// # Errors
/// When a prompt or schema cannot be rendered.
pub(super) fn open_pass(s: &mut AuditState, profiles: &[Profile]) -> Result<(), AuditError> {
    let ctx = prompts::context(s);
    let schema = prompts::lens_schema()?;
    let todo = plan::unanswered(plan::jobs(&s.scout, profiles), &s.tasks);
    for job in plan::buy(todo, s.args.lens_agents) {
        let (Some(p), Some(b)) = (
            plan::profile(profiles, &job.profile),
            plan::batch(&s.scout, &job),
        ) else {
            continue;
        };
        let Some(lens) = p.lens(&job.lens) else {
            continue;
        };
        let files = plan::read_by(p, &job.lens, b);
        let mut task = Task::new(
            format!("lens-{}-{}-{}-{}", s.pass, job.profile, job.lens, job.batch),
            format!(
                "{} {} · batch {} ({} file(s))",
                job.profile,
                job.lens,
                job.batch + 1,
                files.len()
            ),
            prompts::lens_prompt(&ctx, p, lens, &files)?,
            lens.model,
            schema.clone(),
            job.kind(),
        );
        task.agent_type = p.agent_of(&job.lens);
        s.tasks.push(task);
    }
    s.phase = Phase::Lens;
    Ok(())
}

/// Moves the run on once none of its tasks is pending: from the lenses to the verifiers of the
/// findings at Medium and above no verifier holds yet, or, with none, to its end; from the
/// verifiers to its end. Says whether the pass ended.
///
/// # Errors
/// When a prompt or schema cannot be rendered.
pub(super) fn advance(s: &mut AuditState, profiles: &[Profile]) -> Result<bool, AuditError> {
    if s.phase != Phase::Lens {
        s.phase = Phase::Done;
        return Ok(true);
    }
    let found = pool::pool(&s.tasks);
    let groups = pool::batches(&found, &s.tasks);
    let ctx = prompts::context(s);
    let schema = prompts::verify_schema()?;
    let mut fresh = Vec::new();
    for (k, (id, group)) in groups.into_iter().enumerate() {
        let Some(p) = plan::profile(profiles, &id) else {
            continue;
        };
        let findings: Vec<&serde_json::Value> = group
            .iter()
            .filter_map(|&i| found.get(i).map(|f| &f.finding))
            .collect();
        fresh.push(Task::new(
            format!("verify-{}-{k}", s.pass),
            format!("verify {} {id} finding(s)", group.len()),
            prompts::verify_prompt(&ctx, p, &findings)?,
            Model::Opus,
            schema.clone(),
            AuditKind::Verify {
                profile: id,
                findings: group,
            },
        ));
    }
    if fresh.is_empty() {
        s.phase = Phase::Done;
        return Ok(true);
    }
    s.tasks.extend(fresh);
    s.phase = Phase::Verify;
    Ok(false)
}
