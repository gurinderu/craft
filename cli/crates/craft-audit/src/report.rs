//! What a finished audit says: what it read and what it did not, its findings by tier and its
//! verdict, in the review's words — Block on a confirmed Critical or High, Warning on a confirmed
//! Medium, Approve otherwise, and INCOMPLETE in place of Approve (or beside a red verdict) when a
//! file went unread or a finding at Medium or above went unjudged. A file is read only when every
//! lens job over it answered: one not bought by the budget, or whose agent died, is listed in
//! `unread.txt` beside the report, and a resume reads it. The unverified Low and Info findings are
//! counted here and listed in `unverified.md`, as the review holds them apart.

use craft_review::profile::Profile;
use craft_review::settle::Tier;
use serde_json::Value;

use crate::plan;
use crate::state::AuditState;

pub mod markdown;

pub use markdown::markdown;

/// The file of the run's unread paths, one a line.
pub const UNREAD: &str = "unread.txt";
/// The file of its unverified Low and Info findings.
pub const UNVERIFIED: &str = "unverified.md";
/// The verdict of an audit whose profiles took no file.
pub const NOTHING: &str = "Approve (nothing to audit)";

/// A finished pass of an audit, as its report and record say it.
#[derive(Debug, Clone, PartialEq)]
pub struct Summary {
    pub verdict: String,
    /// The paths no answered lens job read, in order.
    pub unread: Vec<String>,
    /// Every lens job the scout's parts need, and how many of them answered.
    pub jobs: usize,
    pub answered: usize,
    /// Every finding settled, in pool order.
    pub settled: Vec<Value>,
    /// The lenses of each profile with files that the audit does not run.
    pub left: Vec<(String, Vec<String>)>,
}

impl Summary {
    /// How many findings are confirmed, suspected, refuted and unverified, in that order.
    #[must_use]
    pub fn tiers(&self) -> [usize; 4] {
        let mut n = [0; 4];
        for f in &self.settled {
            let at = match Tier::of(f) {
                Tier::Confirmed => 0,
                Tier::Suspected => 1,
                Tier::Refuted => 2,
                Tier::Unverified => 3,
            };
            if let Some(c) = n.get_mut(at) {
                *c += 1;
            }
        }
        n
    }

    /// The unverified findings at Medium and above: their verifier died, they were not skipped.
    #[must_use]
    pub fn unjudged(&self) -> usize {
        self.settled
            .iter()
            .filter(|f| {
                Tier::of(f) == Tier::Unverified && !craft_review::report::unverified::held(f)
            })
            .count()
    }

    /// The unverified findings at Low and Info, held apart.
    #[must_use]
    pub fn held(&self) -> Vec<&Value> {
        self.settled
            .iter()
            .filter(|f| craft_review::report::unverified::held(f))
            .collect()
    }
}

/// The paths of the jobs of `s` no task answered, each once, in job order.
fn unread(s: &AuditState, profiles: &[Profile], todo: &[plan::Job]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for job in todo {
        let (Some(p), Some(b)) = (
            plan::profile(profiles, &job.profile),
            plan::batch(&s.scout, job),
        ) else {
            continue;
        };
        for f in plan::read_by(p, &job.lens, b) {
            if !out.contains(&f.path) {
                out.push(f.path);
            }
        }
    }
    out
}

/// The verdict the confirmed findings give, made INCOMPLETE when `incomplete`.
#[must_use]
pub fn verdict(settled: &[Value], incomplete: bool) -> String {
    let mut worst = "Approve";
    for f in settled.iter().filter(|f| Tier::of(f) == Tier::Confirmed) {
        match f.get("severity").and_then(Value::as_str) {
            Some("Critical" | "High") => worst = "Block",
            Some("Medium") if worst == "Approve" => worst = "Warning",
            _ => {}
        }
    }
    match (incomplete, worst) {
        (false, w) => w.to_owned(),
        (true, "Approve") => "INCOMPLETE".to_owned(),
        (true, w) => format!("{w} (INCOMPLETE)"),
    }
}

/// The audit in `s` as it stands, its findings settled.
#[must_use]
pub fn summary(s: &AuditState, profiles: &[Profile]) -> Summary {
    let all = plan::jobs(&s.scout, profiles);
    let jobs = all.len();
    let todo = plan::unanswered(all, &s.tasks);
    let pool = crate::pool::pool(&s.tasks);
    let settled = crate::pool::settle(&pool, &s.tasks);
    let mut sum = Summary {
        verdict: String::new(),
        unread: unread(s, profiles, &todo),
        jobs,
        answered: jobs - todo.len(),
        settled,
        left: s
            .scout
            .parts
            .iter()
            .filter_map(|part| plan::profile(profiles, &part.profile))
            .map(|p| (p.id.clone(), crate::lenses::left(p)))
            .collect(),
    };
    sum.verdict = if jobs == 0 {
        NOTHING.to_owned()
    } else {
        verdict(&sum.settled, !sum.unread.is_empty() || sum.unjudged() > 0)
    };
    sum
}

#[cfg(test)]
mod tests;
