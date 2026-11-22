//! Every coverage gap the review files into `capped`, each written here through
//! [`craft_store::gap::entry`]: its key — the lens and the kind of gap, the same every run — then
//! its run's detail. The rankers across runs read the key back ([`craft_store::gap::key`]).

use craft_store::gap::entry;

/// A metrics lens that could not look, and why (files, errors).
#[must_use]
pub fn could_not_look(lens: &str, why: &str) -> String {
    entry(&format!("metrics-only lens {lens} could not look"), why)
}

/// `profile`'s metrics-only lenses that never returned, each hole as the rounds name it.
#[must_use]
pub fn never_returned(profile: &str, holes: &[String]) -> String {
    entry(
        &format!("{profile} metrics-only lenses that never returned"),
        &holes.join(" · "),
    )
}

/// `profile`'s critic follow-up `lens` that gave no findings.
#[must_use]
pub fn critic_dead(profile: &str, lens: &str) -> String {
    entry(
        &format!("{profile} critic follow-up lens {lens}"),
        CRITIC_DEAD,
    )
}

/// Why a critic follow-up lens is named as not having answered.
pub(crate) const CRITIC_DEAD: &str =
    "dispatched and returned no findings (died, or answered off-schema)";
