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
    let profiles = Profile::all().context("reading the language profiles")?;
    let mut skipped = Skipped::default();
    // A store that cannot be read leaves the yield unknown, not the profile's other parts.
    let (yields, yield_unread) = match project_retro(cwd, &mut skipped) {
        Ok(retro) => (candidates::yields(&retro.lenses), None),
        Err(e) => (Vec::new(), Some(format!("{e:#}"))),
    };
    let offered = candidates::candidates(&yields, &profiles)
        .into_iter()
        .filter_map(|mut c| {
            c.states.retain(|s| !held.contains(&(c.lens.clone(), *s)));
            (!c.states.is_empty()).then_some(c)
        })
        .collect::<Vec<_>>();
    let held: Vec<String> = held
        .iter()
        .map(|(l, s)| format!("{l}={}", name(*s)))
        .collect();
    Ok(json!({
        "held": held,
        "heldUnread": unread,
        "passes": candidates::PASSES,
        "yield": yields,
        "yieldUnread": yield_unread,
        "candidates": offered,
        "unreadRecords": skipped.lines.len() + skipped.records.len(),
    }))
}

/// The retro of the finished runs the store holds for the repository at `cwd`, under the key the
/// store files a run by; none when there is no store yet — a profile is set up before its first
/// review.
fn project_retro(cwd: &Path, skipped: &mut Skipped) -> Result<craft_store::retro::Retro> {
    let project = craft_store::git::repo_key(cwd)
        .to_string_lossy()
        .into_owned();
    match read::home_store().filter(|s| s.is_dir()) {
        Some(store) => {
            crate::runs::retro_where(&store, &|r| r.text_units("project") == project, skipped)
        }
        None => Ok(craft_store::retro::Retro::default()),
    }
}

/// The `--lens <profile:lens>=<state>` entries as the section to write, a lens named twice or an
/// entry a review would refuse refusing it whole.
pub fn confirmed(entries: &[String]) -> Result<BTreeMap<String, State>> {
    let parsed = entries
        .iter()
        .map(|e| parse(e).with_context(|| format!("--lens {e}")))
        .collect::<Result<Vec<_>>>()?;
    let profiles = Profile::all().context("reading the language profiles")?;
    Composition::of(&parsed, &profiles).map_err(|e| anyhow!("--lens: {e}"))?;
    let mut section = BTreeMap::new();
    for (lens, state) in parsed {
        if section.insert(lens.clone(), state).is_some() {
            return Err(anyhow!("--lens {lens}: named twice"));
        }
    }
    Ok(section)
}

fn parse(entry: &str) -> Result<(String, State)> {
    let (lens, state) = entry
        .rsplit_once('=')
        .ok_or_else(|| anyhow!("not <profile:lens>=<state>"))?;
    let state = serde_json::from_value(Value::String(state.to_owned()))
        .with_context(|| format!("{state:?} is none of always, first-round, off"))?;
    Ok((lens.to_owned(), state))
}

/// The state as the section spells it.
fn name(s: State) -> String {
    serde_json::to_value(s)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}
