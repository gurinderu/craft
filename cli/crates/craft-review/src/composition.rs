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

/// A composition entry refused, naming the entry.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Refused {
    /// Not a `profile:lens` name.
    #[error("{0}: not a `profile:lens` name")]
    NotQualified(String),
    /// No profile offers the lens.
    #[error("{0}: no such lens")]
    NoSuchLens(String),
    /// The security lens or a profile's safety lens, held or turned off.
    #[error("{0}: a security lens is never held or turned off")]
    Floor(String),
    /// The concurrency lens turned off.
    #[error("{0}: the concurrency lens is held to the first round at most")]
    ConcurrencyOff(String),
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
    /// `profiles`; `Err` names the first entry refused and why.
    ///
    /// # Errors
    /// An entry naming no profile's lens, a security floor lens held or turned off, or the
    /// concurrency lens turned off.
    pub fn of(lenses: &[(String, State)], profiles: &[Profile]) -> Result<Self, Refused> {
        let mut c = Self::default();
        for (id, state) in lenses {
            let (profile, lens) = split(id).ok_or_else(|| Refused::NotQualified(id.clone()))?;
            let p = profiles
                .iter()
                .find(|p| p.id == profile)
                .filter(|p| p.offers(lens))
                .ok_or_else(|| Refused::NoSuchLens(id.clone()))?;
            let floor = lens == SECURITY || p.safety_lens == lens;
            match state {
                State::Always => {}
                _ if floor => return Err(Refused::Floor(id.clone())),
                State::Off if lens == NEVER_OFF => {
                    return Err(Refused::ConcurrencyOff(id.clone()));
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

pub mod candidates;
mod hold;
pub(crate) use hold::hold;

#[cfg(test)]
mod tests;
