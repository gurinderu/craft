//! The agent budget of the lens rounds (realm @nick/craft, node #634): a later round is bought only
//! while its tasks keep the lens tasks the rounds dispatched within the budget — the launcher's
//! own, else the first round's lens tasks and as many again as those of them a later round may send
//! again — twice the first round when every lens may run again. A round not bought is a ceiling of coverage, like the plan's
//! `max_rounds`, not a hole: what the rounds found goes to verification, and the report names it.

use super::Rounds;
use crate::state::{Task, TaskKind};

impl Rounds {
    /// No round yet, under the launcher's own agent budget when it gave one.
    #[must_use]
    pub fn with_budget(budget: Option<u32>) -> Self {
        Self {
            budget,
            ..Self::default()
        }
    }

    /// The budget the rounds stop at: the launcher's own, else the one the first round set; `None`
    /// when none was set (a state written before it was counted, or a first round no later round
    /// can follow), which no default budget then stops.
    #[must_use]
    pub fn agent_budget(&self) -> Option<u32> {
        self.budget
            .or_else(|| (self.first > 0).then_some(self.auto))
    }

    /// Counts the lens tasks dispatched in the round under way: every one of `lens_tasks` spends the
    /// budget; in the first round, `base` — those a later round may send again
    /// ([`super::resendable`], within their plan's rounds) — make the default budget's base. A
    /// consumer's extra lens and a unit's contract are no lens task and count in neither.
    pub fn count_sent<'a, 'b>(
        &mut self,
        lens_tasks: impl IntoIterator<Item = &'a Task>,
        base: impl IntoIterator<Item = &'b Task>,
    ) {
        let n = u32::try_from(lens_tasks.into_iter().count()).unwrap_or(u32::MAX);
        if self.round <= 1 {
            let b = u32::try_from(base.into_iter().count()).unwrap_or(u32::MAX);
            self.first = self.first.saturating_add(b);
            self.auto = self.auto.saturating_add(n).saturating_add(b);
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
            format!(
                "the first round's {} lens task(s) and {} more for those a later round may send again",
                self.auto.saturating_sub(self.first),
                self.first
            )
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
