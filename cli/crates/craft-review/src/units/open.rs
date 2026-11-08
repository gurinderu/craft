//! Whether unit mode runs for each profile taking part, and over which slices (#362): the units its
//! profile finds, the ones the change touches, and the batches of the change.

use std::path::Path;

use super::batch::{BATCH_BUDGET, Graph, batch_by_unit};
use super::scope::touched_units;
use super::{UnitTrack, Units, dirs, discover};
use crate::profile::Profile;
use crate::state::Track;

/// Unit mode for the run's `tracks` over the changed `files`, measured against `base` in the
/// repository at `top`; off unless `asked`.
#[must_use]
pub fn open(
    asked: bool,
    top: &Path,
    base: &str,
    files: &[String],
    tracks: &[Track],
    profiles: &[Profile],
) -> Units {
    let mut units = Units {
        asked,
        ..Units::default()
    };
    if !asked {
        return units;
    }
    for p in profiles
        .iter()
        .filter(|p| tracks.iter().any(|t| t.profile == p.id))
    {
        match open_track(top, base, files, p) {
            Ok(t) => units.tracks.push(t),
            Err(why) => units.notices.push(format!(
                "Unit mode {why} — the review ran in the normal mode."
            )),
        }
    }
    units
}

/// One profile's unit track, or why the mode cannot run for it (#362): no units in its profile, a
/// failed discovery, no unit in the change, or a change too small to slice.
fn open_track(top: &Path, base: &str, files: &[String], p: &Profile) -> Result<UnitTrack, String> {
    let Some(words) = &p.units else {
        return Err(format!(
            "not available for {}: its profile finds no units",
            p.lang
        ));
    };
    let failed = |e: String| {
        format!(
            "skipped, the {} probe failed on the {} change ({e})",
            words.noun, p.lang
        )
    };
    let packages = discover::cargo(top).map_err(failed)?;
    let numstat = discover::numstat(top, base).map_err(failed)?;
    let roots: Vec<String> = packages.iter().map(|x| x.root.clone()).collect();
    let units = touched_units(files, &roots);
    if units.is_empty() {
        return Err(format!("found no {} in the {} change", words.noun, p.lang));
    }
    let owns = |f: &str| p.covers(f);
    let graph = Graph {
        roots: &roots,
        packages: &packages,
        numstat: &numstat,
    };
    let slices = batch_by_unit(files, &graph, BATCH_BUDGET, &owns);
    if slices.is_empty() {
        let owned = dirs::partition_owned(files, &owns).1.len();
        return Err(format!("skipped, change too small to slice: {owned} files"));
    }
    Ok(UnitTrack {
        profile: p.id.clone(),
        slices,
        units,
        questions: Vec::new(),
        seam: None,
    })
}
