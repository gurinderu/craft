//! The project's lens composition from the reviewer's profile (realm @nick/craft, node #644): a
//! lens of a profile (`rust:money`) is off, or held to the first round, or as its profile says.
//! "First round only" is the language profile's own round ceiling (`rounds`, node #632) lowered to
//! one — the same reader, no second mechanism; "off" leaves the lens out of the plan, named in the
//! report. The security lens and a profile's safety lens are never touched, the concurrency lens is
//! never off (held to the first round, it is taken): a composition breaking either is refused
//! whole. A run started with `--all-lenses` (the release's full review) takes no composition and
//! says so, and so rechecks what a reviewer turned off.

use std::num::NonZeroU32;

use serde::{Deserialize, Serialize};

use crate::plan::Plan;
use crate::profile::Profile;

/// The security lens, which the composition never touches, as it never touches a profile's safety
/// lens (`safetyLens`).
const SECURITY: &str = "security";
/// The lens the composition may hold to the first round but never turn off.
const NEVER_OFF: &str = "concurrency";

/// What a lens is in the composition.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum State {
    /// As its profile says.
    Always,
    /// Its first round only.
    FirstRound,
    /// Out of the plan.
    Off,
}

/// The composition a run applies: each lens qualified by its profile, `rust:money`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Composition {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub off: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub first_round: Vec<String>,
}

impl Composition {
    /// Whether it changes nothing.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.off.is_empty() && self.first_round.is_empty()
    }

    /// The composition of `lenses`, each `profile:lens` with its state, checked against
    /// `profiles`; `Err` names the first entry refused.
    ///
    /// # Errors
    /// An entry naming no profile's lens, a security floor lens held or turned off, or the
    /// concurrency lens turned off.
    pub fn of(lenses: &[(String, State)], profiles: &[Profile]) -> Result<Self, String> {
        let mut c = Self::default();
        for (id, state) in lenses {
            let (profile, lens) =
                split(id).ok_or_else(|| format!("{id}: not a `profile:lens` name"))?;
            let p = profiles
                .iter()
                .find(|p| p.id == profile)
                .filter(|p| p.offers(lens))
                .ok_or_else(|| format!("{id}: no such lens"))?;
            let floor = lens == SECURITY || p.safety_lens == lens;
            match state {
                State::Always => {}
                _ if floor => {
                    return Err(format!("{id}: a security lens is never held or turned off"));
                }
                State::Off if lens == NEVER_OFF => {
                    return Err(format!(
                        "{id}: the concurrency lens is held to the first round at most"
                    ));
                }
                State::Off => c.off.push(id.clone()),
                State::FirstRound => c.first_round.push(id.clone()),
            }
        }
        Ok(c)
    }

    /// The report's line of what it changed; `None` when it changed nothing.
    #[must_use]
    pub fn line(&self) -> Option<String> {
        let part = |names: &[String], what: &str| {
            (!names.is_empty()).then(|| format!("{what}: {}", names.join(", ")))
        };
        let parts: Vec<String> = [
            part(&self.off, "turned off"),
            part(&self.first_round, "held to the first round"),
        ]
        .into_iter()
        .flatten()
        .collect();
        (!parts.is_empty()).then(|| {
            format!(
                "the reviewer's profile composes the lenses — {}",
                parts.join("; ")
            )
        })
    }
}

fn split(id: &str) -> Option<(&str, &str)> {
    id.split_once(':')
        .filter(|(p, l)| !p.is_empty() && !l.is_empty())
}

/// The lenses of `profile` named in `names`.
fn of_profile<'a>(names: &'a [String], profile: &'a str) -> impl Iterator<Item = &'a str> {
    names
        .iter()
        .filter_map(move |n| split(n).filter(|(p, _)| *p == profile).map(|(_, l)| l))
}

/// Lowers each held lens's round ceiling to one in its profile, the ceiling the rounds read.
pub fn apply(profiles: &mut [Profile], c: &Composition) {
    for p in profiles.iter_mut() {
        let held: Vec<String> = of_profile(&c.first_round, &p.id)
            .map(str::to_owned)
            .collect();
        for l in p.lenses.iter_mut().filter(|l| held.contains(&l.id)) {
            l.rounds = Some(NonZeroU32::MIN);
        }
    }
}

/// Leaves the lenses `c` turns off out of `plan`, the plan of `profile`, and out of every list of
/// what it held back for another reason, so none is a candidate the critic may buy back or a
/// coverage gap; each is named in its `profile_off`. What the run asked for itself, `asked` —
/// strict mode's maintainability lens, an optional lens it bought — stays: the run's own word
/// is the later one. A part the composition would leave with no lens keeps its plan whole: the
/// line returned says so, as an Approve on nothing read would not.
pub(crate) fn hold(
    plan: &mut Plan,
    c: &Composition,
    profile: &str,
    asked: &[String],
) -> Option<String> {
    let off: Vec<String> = of_profile(&c.off, profile)
        .filter(|l| !asked.iter().any(|a| a == l))
        .map(str::to_owned)
        .collect();
    if off.is_empty() {
        return None;
    }
    if !plan.lenses.is_empty() && plan.lenses.iter().all(|l| off.contains(l)) {
        return Some(format!(
            "the reviewer's profile would turn off every lens planned for {profile}'s part ({}): they all run",
            plan.lenses.join(", ")
        ));
    }
    for list in [
        &mut plan.lenses,
        &mut plan.metrics_dropped,
        &mut plan.signal_skipped,
        &mut plan.light_skipped,
        &mut plan.data_skipped,
        &mut plan.surface_dropped,
    ] {
        list.retain(|l| !off.contains(l));
    }
    plan.profile_off = off;
    None
}

#[cfg(test)]
mod tests;
