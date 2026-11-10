//! A candidate `--propose` resolves that collides with another job of its workflow (realm
//! @nick/craft, node #482): left unresolved, the refusal `--write` would give leading its note.

use super::candidates::{Candidate, Resolved, Unresolved};
use super::check_claim::{Placed, collision};
use super::workflow::Job;

/// `found`, each resolved candidate that collides with another job of `workflow`'s `all` left
/// unresolved.
pub(super) fn unclaimed(workflow: &str, all: &[Job], found: Vec<Candidate>) -> Vec<Candidate> {
    let all: Vec<Placed<'_>> = all.iter().map(|j| (workflow, j)).collect();
    let one = |c| match c {
        Candidate::Resolved(r) => match collision(&all, &r.check, &r.command) {
            Some(e) => Candidate::Unresolved(collided(r, e.to_string())),
            None => Candidate::Resolved(r),
        },
        u @ Candidate::Unresolved(_) => u,
    };
    found.into_iter().map(one).collect()
}

/// The unresolved form of resolved `r`, `why` it collides leading its note.
fn collided(r: Resolved, why: String) -> Unresolved {
    let note = match r.note {
        Some(n) => format!("{why}; {n}"),
        None => why,
    };
    Unresolved {
        check: r.check,
        matrix: r.matrix,
        runs: vec![r.command],
        hints: vec![r.signal],
        workflow: r.workflow,
        uses: r.uses,
        note: Some(note),
    }
}
