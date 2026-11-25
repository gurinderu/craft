//! The agent budget of the lens rounds (realm @nick/craft, node #634): a later round is bought only
//! while its tasks keep the tasks the rounds dispatched within the budget — the launcher's own, else
//! twice the first round's. A round not bought is a ceiling of coverage, like the plan's
//! `max_rounds`, not a hole: what the rounds found goes to verification, and the report names it.

use super::Rounds;
use crate::state::{Task, TaskKind};

/// The default budget, in first rounds.
const FIRST_ROUNDS: u32 = 2;

impl Rounds {
    /// No round yet, under the launcher's own agent budget when it gave one.
    #[must_use]
    pub fn with_budget(budget: Option<u32>) -> Self {
        Self {
            budget,
            ..Self::default()
        }
    }

    /// The budget the rounds stop at: the launcher's own, else twice the first round's tasks;
    /// `None` while the first round's count is unknown (a state written before it was kept).
    #[must_use]
    pub fn agent_budget(&self) -> Option<u32> {
        self.budget
            .or_else(|| (self.first > 0).then(|| self.first.saturating_mul(FIRST_ROUNDS)))
    }

    /// Counts the lens tasks dispatched in the round under way. Only those of a lens a later round
    /// may send again are counted — a consumer's extra lens and a unit's contract run beside the
    /// first round alone, so they neither widen the default budget nor spend it.
    pub fn count_sent<'a>(&mut self, lens_tasks: impl IntoIterator<Item = &'a Task>) {
        let n = u32::try_from(lens_tasks.into_iter().count()).unwrap_or(u32::MAX);
        if self.round <= 1 {
            self.first = self.first.saturating_add(n);
        }
        self.sent = self.sent.saturating_add(n);
    }

    /// Why the round under way, of `lens_tasks`, is not bought, naming each dispatch it would have
    /// sent; `None` when it fits the budget. The first round is always bought.
    #[must_use]
    pub fn over_budget<'a>(
        &self,
        lens_tasks: impl IntoIterator<Item = &'a Task>,
    ) -> Option<String> {
        if self.round <= 1 {
            return None;
        }
        let budget = self.agent_budget()?;
        let lens_tasks: Vec<&Task> = lens_tasks.into_iter().collect();
        let n = lens_tasks.len();
        let total = u64::from(self.sent).saturating_add(u64::try_from(n).unwrap_or(u64::MAX));
        if total <= u64::from(budget) {
            return None;
        }
        let whose = if self.budget.is_some() {
            "the launcher's --lens-agents".to_owned()
        } else {
            format!("twice the first round's {} task(s)", self.first)
        };
        let left: Vec<String> = lens_tasks.iter().copied().filter_map(dispatch).collect();
        Some(format!(
            "lens round {} not bought: its {n} task(s) would bring the lens rounds to {total} agent(s), over the budget of {budget} ({whose}); not run in it: {}; what the rounds found went on to verification",
            self.round,
            left.join(", ")
        ))
    }
}

/// A lens dispatch as the report names it: `profile:lens`, then its slice when sliced.
fn dispatch(t: &Task) -> Option<String> {
    let TaskKind::Lens {
        profile,
        lens,
        slice,
        ..
    } = &t.kind
    else {
        return None;
    };
    Some(match slice {
        Some(s) => format!("{profile}:{lens} ({s})"),
        None => format!("{profile}:{lens}"),
    })
}
