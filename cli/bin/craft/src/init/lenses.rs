//! The lens composition `craft init` proposes from the repository's runs and writes as the reviewer
//! confirmed it (realm @nick/craft, node #647).

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{Context, Result, anyhow};
use craft_review::composition::{Composition, State, candidates};
use craft_review::profile::Profile;
use craft_store::read::{self, Skipped};
use serde_json::{Value, json};

/// What `--propose` says of the lenses: the section the profile holds, in the `--lens` form a write
/// takes back, or why it could not be read; each lens's yield over the repository's runs; and the
/// lenses that yield offers.
pub fn proposed(cwd: &Path, profile: &Path) -> Result<Value> {
    let (held, unread) = match craft_review::project::lenses::of(profile) {
        Ok(entries) => (entries, None),
        Err(e) => (Vec::new(), Some(e.to_string())),
    };
    let held: Vec<String> = held
        .iter()
        .map(|(l, s)| format!("{l}={}", name(*s)))
        .collect();
    let project = craft_store::git::repo_key(cwd)
        .to_string_lossy()
        .into_owned();
    let mut skipped = Skipped::default();
    // No store yet is no run yet, not a failure: a profile is set up before its first review.
    let retro = match read::home_store().filter(|s| s.is_dir()) {
        Some(store) => crate::runs::retro_where(
            &store,
            &|r| r.text_units("project") == project,
            &mut skipped,
        )?,
        None => craft_store::retro::Retro::default(),
    };
    let yields = candidates::yields(&retro.lenses);
    let profiles = Profile::all().context("reading the language profiles")?;
    Ok(json!({
        "held": held,
        "heldUnread": unread,
        "passes": candidates::PASSES,
        "yield": yields,
        "candidates": candidates::candidates(&yields, &profiles),
        "unreadRecords": skipped.lines.len() + skipped.records.len(),
    }))
}

/// The `--lens <profile:lens>=<state>` entries as the section to write, refused whole as a review
/// would refuse it.
pub fn confirmed(entries: &[String]) -> Result<BTreeMap<String, State>> {
    let parsed = entries
        .iter()
        .map(|e| parse(e).with_context(|| format!("--lens {e}")))
        .collect::<Result<Vec<_>>>()?;
    let profiles = Profile::all().context("reading the language profiles")?;
    Composition::of(&parsed, &profiles).map_err(|e| anyhow!("--lens: {e}"))?;
    Ok(parsed.into_iter().collect())
}

fn parse(entry: &str) -> Result<(String, State)> {
    let (lens, state) = entry
        .rsplit_once('=')
        .ok_or_else(|| anyhow!("not <profile:lens>=<state>"))?;
    let state = match state {
        "always" => State::Always,
        "first-round" => State::FirstRound,
        "off" => State::Off,
        other => return Err(anyhow!("{other:?} is none of always, first-round, off")),
    };
    Ok((lens.to_owned(), state))
}

fn name(s: State) -> &'static str {
    match s {
        State::Always => "always",
        State::FirstRound => "first-round",
        State::Off => "off",
    }
}
