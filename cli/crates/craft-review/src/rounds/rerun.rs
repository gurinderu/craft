//! Which lens dispatches a later round runs again (realm @nick/craft, node #625): round 2 and later rerun only the dispatches — a lens of a
//! profile, on its slice when sliced — whose answer in the round before held a finding the pool
//! lacked, or that gave none; the plan's `max_rounds` stays the ceiling.

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

impl Rounds {
    /// Whether the dispatch keyed `k` runs in the round under way: always in the first, and in a
    /// later one when the round before marked it to run again (or that is not known).
    pub(crate) fn reruns(&self, k: &str) -> bool {
        self.round <= 1 || self.rerun.as_ref().is_none_or(|y| y.iter().any(|x| x == k))
    }

    /// Whether a round after the last one absorbed would dispatch any lens of `profile`'s `plan`.
    #[must_use]
    pub fn reruns_any(&self, profile: &Profile, plan: &Plan) -> bool {
        let Some(again) = &self.rerun else {
            return true;
        };
        plan.lenses
            .iter()
            .filter(|l| !first_only(profile, l))
            .any(|l| {
                let k = lens_key(&profile.id, l);
                let sliced = format!("{k}{SLICE_SEP}");
                again.iter().any(|y| *y == k || y.starts_with(&sliced))
            })
    }
}
