//! The store's records walked once, a resumed run once, a retro's mark passed by: each record as it is read (one with no
//! schema version, one that died, one that finished), then each finished run `keep` keeps by the
//! record standing for it — a re-filed record folded into its newest, a stopped part into the
//! record its resume finished ([`craft_store::parts`]) — the parts noted for pricing after.

use std::path::Path;

use anyhow::{Context, Result};
use craft_store::js::{Js, Obj, Utf16Error};
use craft_store::parts::Parts;
use craft_store::read::{self, Skipped};

/// A record as the walk meets it.
pub(crate) enum Seen<'a> {
    /// A record with no schema version, read past.
    Legacy(&'a Obj),
    /// A record that finished, before any fold or filter.
    Live(&'a Obj),
    /// A record of a run that died.
    Died(&'a Obj),
    /// The record standing for a finished run `keep` keeps, by its name.
    Standing(&'a str, &'a Obj),
}

/// What the walk passed by.
#[derive(Debug, Default)]
pub(crate) struct Counts {
    /// Records `keep` does not keep, or with no schema version.
    pub other: u64,
    /// Records of runs that died, that `keep` keeps.
    pub unfinished: u64,
    /// Records folded into a newer one of the same run.
    pub folded: u64,
    /// Records with no schema version.
    pub legacy: u64,
}

type Each<'e> = dyn FnMut(Seen<'_>) -> Result<(), Utf16Error> + 'e;

fn finished(r: &Obj) -> (bool, bool) {
    (
        r.get("schemaVersion").is_some_and(Js::truthy),
        r.get("partial").is_some_and(Js::truthy),
    )
}

/// Walks `store`, handing `each` every record as [`Seen`] names it.
/// # Errors
/// When the store cannot be read, or `each` fails.
pub(crate) fn walk(
    store: &Path,
    keep: &dyn Fn(&Obj) -> bool,
    skipped: &mut Skipped,
    each: &mut Each<'_>,
) -> Result<(Counts, Parts)> {
    let mut counts = Counts::default();
    let mut newest = std::collections::BTreeMap::<String, (String, String)>::new();
    let mut parts = Parts::default();
    let mut failure = None;
    read::records(store, skipped, |name, r| {
        // A retro's mark is no run: out before any count, fold or filter (realm @nick/craft, node #658).
        if r.text_units("kind") == craft_store::retro::DONE_KIND {
            return;
        }
        let (schema, died) = finished(&r);
        let inside = keep(&r);
        let seen = if !schema {
            counts.legacy += 1;
            Seen::Legacy(&r)
        } else if died {
            Seen::Died(&r)
        } else {
            parts.note(name, &r);
            Seen::Live(&r)
        };
        if let Err(e) = each(seen) {
            failure = Some(e);
            return;
        }
        if schema && !died && super::held(&mut parts, (name, &r, inside), &mut failure) {
            // Counted, or folded, once every record is read, as the run's standing part is.
            counts.other += u64::from(!inside);
        } else if !schema || !inside {
            counts.other += 1;
        } else if died {
            counts.unfinished += 1;
        } else if let Some(key) = craft_store::retro::run_key(&r) {
            let ts = match r.try_text("ts") {
                Ok(ts) => ts.to_owned(),
                Err(e) => {
                    failure = Some(e);
                    return;
                }
            };
            match newest.entry(key) {
                std::collections::btree_map::Entry::Vacant(e) => {
                    e.insert((ts, name.to_owned()));
                }
                std::collections::btree_map::Entry::Occupied(mut e) => {
                    counts.folded += 1;
                    if ts > e.get().0 {
                        e.insert((ts, name.to_owned()));
                    }
                }
            }
        } else if let Err(e) = each(Seen::Standing(name, &r)) {
            failure = Some(e);
        }
    })
    .with_context(|| format!("reading {}", store.display()))?;
    if let Some(e) = failure {
        return Err(e.into());
    }
    for (key, (ts, name)) in newest {
        match read::record(store, &name) {
            Ok(r)
                if r.text_units("ts") == ts
                    && keep(&r)
                    && finished(&r) == (true, false)
                    && craft_store::retro::run_key(&r).as_ref() == Some(&key) =>
            {
                each(Seen::Standing(&name, &r))?;
            }
            Ok(_) => skipped
                .records
                .push((name, "record changed while reading".into())),
            Err(why) => skipped.records.push((name, why)),
        }
    }
    let (standing, folded) = parts.standing();
    counts.folded += folded;
    for (name, r) in super::read_back(store, standing, skipped, keep) {
        each(Seen::Standing(&name, &r))?;
    }
    Ok((counts, parts))
}
