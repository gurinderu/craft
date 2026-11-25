//! Which lens dispatches a later round sends again (realm @nick/craft, node #625): round 2 and
//! later send only the dispatches — a lens of a profile, on its slice when sliced — whose answer in
//! the round before held a finding the pool lacked, a lens past its own round limit excepted. A
//! dispatch that gave no answer after its retries within its round is a hole the verdict reads as
//! INCOMPLETE, as in a one-round plan; no later round sends it again. The plan's `max_rounds`
//! stays the ceiling.

use std::collections::BTreeSet;

use serde_json::Value;

use super::{Rounds, SLICE_SEP, key, lens_key};
use crate::plan::Plan;
use crate::profile::Profile;

/// The rounds `lens` runs at most, `None` when only the plan bounds it: one for a metrics lens,
/// which reads numbers another round would not change, and for the design lens, whose decisions
/// another round would not change (realm @nick/craft, node #534); otherwise its profile's own
/// limit (realm @nick/craft, node #632).
pub(super) fn limit(profile: &Profile, lens: &str) -> Option<u32> {
    if lens == crate::design::LENS {
        return Some(1);
    }
    let l = profile.lens(lens)?;
    if l.metrics { Some(1) } else { l.rounds }
}

/// Whether `lens` may run in `round`.
fn within(profile: &Profile, lens: &str, round: u32) -> bool {
    limit(profile, lens).is_none_or(|n| round <= n)
}

/// Whether `answer` holds a finding whose key `before` lacks.
pub(super) fn found_new(answer: &Value, before: &BTreeSet<String>) -> bool {
    answer
        .get("findings")
        .and_then(Value::as_array)
        .is_some_and(|fs| fs.iter().any(|f| !before.contains(&key(f))))
}

/// Whether `k` is a dispatch of the lens keyed `lens`: the lens itself or one of its slices.
fn of_lens(k: &str, lens: &str) -> bool {
    k == lens
        || k.strip_prefix(lens)
            .is_some_and(|r| r.starts_with(SLICE_SEP))
}

impl Rounds {
    /// Whether the dispatch keyed `k`, of `profile`'s `lens`, runs in the round under way: always in
    /// the first; in a later one when its answer in the round before found something new and the
    /// round is within the lens's limit (all of those when what it found is not known).
    pub(crate) fn sends(&self, profile: &Profile, lens: &str, k: &str) -> bool {
        self.round <= 1
            || (within(profile, lens, self.round)
                && self.rerun.as_ref().is_none_or(|y| y.iter().any(|x| x == k)))
    }

    /// Whether a round after the last one absorbed would dispatch any lens of `profile`'s `plan`:
    /// the round `found_new` something, and a lens that found it may run in the next round. A
    /// profile whose dispatches all died or found nothing new starts no round.
    #[must_use]
    pub fn goes_on(&self, profile: &Profile, plan: &Plan, found_new: bool) -> bool {
        // A later round: at least the second, whatever round the absorbed one was numbered.
        let next = self.round.max(1) + 1;
        found_new
            && plan
                .lenses
                .iter()
                .filter(|l| within(profile, l, next))
                .any(|l| {
                    let lens = lens_key(&profile.id, l);
                    self.rerun
                        .as_ref()
                        .is_none_or(|y| y.iter().any(|k| of_lens(k, &lens)))
                })
    }
}
