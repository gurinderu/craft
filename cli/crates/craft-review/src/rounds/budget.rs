//! The agent budget of the lens rounds (realm @nick/craft, node #634): a later round is bought only
//! while its tasks keep the tasks the rounds dispatched within the budget — the launcher's own, else
//! twice the first round's. A round not bought is a ceiling of coverage, like the plan's
//! `max_rounds`, not a hole: what the rounds found goes to verification, and the report names it.

use super::Rounds;

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

    /// Counts `n` tasks dispatched in the round under way.
    pub fn count_sent(&mut self, n: usize) {
        let n = u32::try_from(n).unwrap_or(u32::MAX);
        if self.round <= 1 {
            self.first = self.first.saturating_add(n);
        }
        self.sent = self.sent.saturating_add(n);
    }

    /// Why the round under way, of `n` tasks, is not bought; `None` when it fits the budget. The
    /// first round is always bought.
    #[must_use]
    pub fn over_budget(&self, n: usize) -> Option<String> {
        if self.round <= 1 {
            return None;
        }
        let budget = self.agent_budget()?;
        let total = u64::from(self.sent).saturating_add(u64::try_from(n).unwrap_or(u64::MAX));
        if total <= u64::from(budget) {
            return None;
        }
        let whose = if self.budget.is_some() {
            "the launcher's --lens-agents".to_owned()
        } else {
            format!("twice the first round's {} task(s)", self.first)
        };
        Some(format!(
            "lens round {} not bought: its {n} task(s) would bring the lens rounds to {total} agent(s), over the budget of {budget} ({whose}); what the rounds found went on to verification",
            self.round
        ))
    }
}
