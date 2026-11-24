//! Which lens dispatches a later round sends again (realm @nick/craft, node #625): round 2 and
//! later send the dispatches — a lens of a profile, on its slice when sliced — whose answer in the
//! round before held a finding the pool lacked, a first-round-only lens excepted, and, once more,
//! those that gave no answer, a first-round-only one included, whatever the round found; the plan's
//! `max_rounds` stays the ceiling.

use std::collections::BTreeSet;

use serde_json::Value;

use super::{Rounds, SLICE_SEP, key, lens_key};
use crate::plan::Plan;
use crate::profile::Profile;

/// Whether `lens` runs in the first round only: a metrics lens reads numbers another round would
/// not change, and the design lens decisions another round would not change (realm @nick/craft,
/// node #534).
pub(super) fn first_only(profile: &Profile, lens: &str) -> bool {
    lens == crate::design::LENS || profile.lens(lens).is_some_and(|x| x.metrics)
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
    /// the first; in a later one when it gave no answer in the round before, or when its answer
    /// then found something new and it is no first-round-only lens (all of them when that is not
    /// known).
    pub(crate) fn sends(&self, profile: &Profile, lens: &str, k: &str) -> bool {
        self.round <= 1
            || self.retry.iter().any(|x| x == k)
            || (!first_only(profile, lens)
                && self.rerun.as_ref().is_none_or(|y| y.iter().any(|x| x == k)))
    }

    /// Whether a round after the last one absorbed would dispatch any lens of `profile`'s `plan`:
    /// one that gave no answer, or, when the round `found_new`, one that found it.
    #[must_use]
    pub fn goes_on(&self, profile: &Profile, plan: &Plan, found_new: bool) -> bool {
        let keyed = |l: &String| lens_key(&profile.id, l);
        let retried = plan
            .lenses
            .iter()
            .any(|l| self.retry.iter().any(|k| of_lens(k, &keyed(l))));
        let yielded = |l: &&String| {
            self.rerun
                .as_ref()
                .is_none_or(|y| y.iter().any(|k| of_lens(k, &keyed(l))))
        };
        retried
            || (found_new
                && plan
                    .lenses
                    .iter()
                    .filter(|l| !first_only(profile, l))
                    .any(|l| yielded(&l)))
    }
}
