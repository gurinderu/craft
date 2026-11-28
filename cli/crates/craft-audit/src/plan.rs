//! The lens agents an audit needs and the ones a pass buys: one job per lens an audit runs
//! ([`crate::lenses`]) over each batch of its profile's part, but a lens that reads none of the
//! batch's files (the general profile's per-file lenses read no data file). A pass buys the jobs
//! not yet answered, in order, as many as its budget allows; no job is sampled away, a job not
//! bought leaves its files unread, and the next pass buys it.

use craft_review::profile::Profile;
use craft_step::TaskState;
use serde::{Deserialize, Serialize};

use crate::batch::{Batch, Tracked};
use crate::kind::AuditKind;
use crate::scout::Scouted;
use crate::state::Task;

/// One lens over one batch of a profile's part.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Job {
    pub profile: String,
    pub lens: String,
    pub batch: usize,
}

impl Job {
    /// The task kind that answers it.
    #[must_use]
    pub fn kind(&self) -> AuditKind {
        AuditKind::Lens {
            profile: self.profile.clone(),
            lens: self.lens.clone(),
            batch: self.batch,
        }
    }
}

/// The profile `id` of `profiles`.
#[must_use]
pub fn profile<'a>(profiles: &'a [Profile], id: &str) -> Option<&'a Profile> {
    profiles.iter().find(|p| p.id == id)
}

/// The batch a job reads, of the scout's part of its profile.
#[must_use]
pub fn batch<'a>(scout: &'a Scouted, job: &Job) -> Option<&'a Batch> {
    scout
        .parts
        .iter()
        .find(|p| p.profile == job.profile)
        .and_then(|p| p.batches.get(job.batch))
}

/// The files of `batch` the lens `lens` of `profile` reads.
#[must_use]
pub fn read_by(profile: &Profile, lens: &str, batch: &Batch) -> Vec<Tracked> {
    let read = profile.reads(lens, &batch.paths());
    batch
        .files
        .iter()
        .filter(|f| read.contains(&f.path))
        .cloned()
        .collect()
}

/// Every job the scout's parts need, part by part, batch by batch, lens by lens.
#[must_use]
pub fn jobs(scout: &Scouted, profiles: &[Profile]) -> Vec<Job> {
    let mut out = Vec::new();
    for part in &scout.parts {
        let Some(p) = profile(profiles, &part.profile) else {
            continue;
        };
        for (at, b) in part.batches.iter().enumerate() {
            for lens in crate::lenses::audited(p) {
                if !p.reads_nothing(&lens.id, &b.paths()) {
                    out.push(Job {
                        profile: p.id.clone(),
                        lens: lens.id.clone(),
                        batch: at,
                    });
                }
            }
        }
    }
    out
}

/// Whether some task answered `job`.
#[must_use]
pub fn answered(tasks: &[Task], job: &Job) -> bool {
    let kind = job.kind();
    tasks
        .iter()
        .any(|t| t.kind == kind && t.state == TaskState::Answered)
}

/// The jobs of `all` no task answered yet, in order.
#[must_use]
pub fn unanswered(all: Vec<Job>, tasks: &[Task]) -> Vec<Job> {
    all.into_iter().filter(|j| !answered(tasks, j)).collect()
}

/// The jobs a pass buys of `todo`: the first `budget` of them, every one without a budget.
#[must_use]
pub fn buy(todo: Vec<Job>, budget: Option<usize>) -> Vec<Job> {
    match budget {
        Some(n) => todo.into_iter().take(n).collect(),
        None => todo,
    }
}

#[cfg(test)]
mod tests;
