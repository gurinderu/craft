//! What a resume does before anything else, and what the host says on a submit.

use std::path::Path;

use super::kept::{load, save};
use super::{Record, Writer, unfiled, write};

/// What the host says on a submit beside its answers.
#[derive(Debug, Clone, Default)]
pub struct Host {
    /// The task agents it has dispatched so far, and the output tokens its run has spent.
    pub agents: Option<u64>,
    pub output_tokens: Option<u64>,
    /// It resumes the run (`--resume`): a new segment, filed apart, as a new host run files its own.
    pub resume: bool,
    pub session: String,
}

/// Before a resume does anything else: a stopped segment whose record did not land joins the
/// pending ones, and each pending record is filed again, as a retry, kept until it lands. Says what
/// did not land, and how to file what is still pending.
pub fn resuming(run: &Path, w: &dyn Writer) -> Vec<String> {
    let Some(mut filing) = load(run) else {
        return Vec::new();
    };
    let done = crate::state::load(run).is_ok_and(|s| s.phase == crate::state::Phase::Done);
    if !done && unfiled(&filing).is_some() {
        let mut ended = std::mem::take(&mut filing);
        filing.ctx = ended.ctx.clone();
        filing.session.clone_from(&ended.session);
        filing.pending = std::mem::take(&mut ended.pending);
        filing.pending.push(ended);
    }
    let mut lost = Vec::new();
    for mut part in std::mem::take(&mut filing.pending) {
        let Some(step) = part.finished.clone() else {
            continue;
        };
        part.attempts += 1;
        let mut said = Vec::new();
        write::record(run, &mut part, &step, true, &mut said, w);
        lost.extend(said.into_iter().map(|l| {
            l.replacen(
                "the run record",
                "the record of a stopped part of this run",
                1,
            )
        }));
        if part.record != Record::Filed {
            filing.pending.push(part);
        }
    }
    if !filing.pending.is_empty() {
        let d = run.display().to_string().replace('\'', r"'\''");
        lost.push(format!(
            "{} stopped part(s) of this run still have no record — resume the run again (`craft review submit --run '{d}' --resume`) to file them",
            filing.pending.len()
        ));
    }
    save(run, &filing, &mut lost);
    lost
}
