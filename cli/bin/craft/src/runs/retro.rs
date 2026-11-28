//! `craft runs retro`: the finished runs the filters keep summed ([`craft_store::retro`]), with
//! `--engine` one engine's — `latest` the newest run's — and the runs that did not finish listed
//! by the same slice.

use std::io::Write;
use std::path::Path;

use anyhow::{Context, Result, bail};
use craft_store::js::{Js, Obj};
use craft_store::read::{self, Skipped};
use craft_store::retro::unfinished::{self, Unfinished, slice::Slice};

use super::{FilterArgs, render, visit};

/// The retro of the finished runs `keep` keeps — one version's, one repository's — read from the
/// store at `store`, a resumed run once.
pub(crate) fn retro_where(
    store: &Path,
    keep: &dyn Fn(&Obj) -> bool,
    skipped: &mut Skipped,
) -> Result<craft_store::retro::Retro> {
    retro_walk(store, keep, None, skipped)
}

/// [`retro_where`], and with `slice` the runs that did not finish listed by it.
fn retro_walk(
    store: &Path,
    keep: &dyn Fn(&Obj) -> bool,
    slice: Option<&Slice<'_>>,
    skipped: &mut Skipped,
) -> Result<craft_store::retro::Retro> {
    let mut out = craft_store::retro::Retro::default();
    let mut unfinished = Unfinished::default();
    let whole = slice.is_none_or(Slice::is_whole);
    let inside = |r: &Obj| {
        if whole {
            Some(true)
        } else {
            slice.and_then(|s| unfinished::slice::inside(r, s))
        }
    };
    let (counts, parts) = visit::walk(store, keep, skipped, &mut |seen| match seen {
        visit::Seen::Standing(name, r) => craft_store::retro::add_record(&mut out, name, r),
        visit::Seen::Live(r) if slice.is_some() => {
            unfinished.complete(r, inside(r));
            Ok(())
        }
        visit::Seen::Died(r) if slice.is_some() => {
            unfinished.partial(r, inside(r));
            Ok(())
        }
        visit::Seen::Legacy(_) | visit::Seen::Live(_) | visit::Seen::Died(_) => Ok(()),
    })?;
    out.other += counts.other;
    out.unfinished += counts.unfinished;
    out.folded += counts.folded;
    out.legacy += counts.legacy;
    craft_store::retro::settle(&mut out, &parts);
    out.chains = out
        .contradictions
        .settle(|name| read::record(store, name).ok()?.get("ledger").cloned());
    (out.listed, out.listed_unattributed, out.listed_twins) = unfinished.settle(whole);
    Ok(out)
}

/// `craft runs retro`: the filters, `at` the version, and the engine, `latest` the newest run's.
pub(super) fn command(
    out: &mut dyn Write,
    store: &Path,
    (at, filter, engine): (&Option<String>, &FilterArgs, Option<&str>),
    json: bool,
    skipped: &mut Skipped,
) -> Result<()> {
    let mut filter = filter.filter();
    filter.version = filter.version.or_else(|| at.clone());
    let engine = match engine {
        Some("latest") => match latest_engine(store, &filter)? {
            Some(e) => Some(e),
            None => bail!(
                "no finished run the filters keep in {} to pick the latest engine from",
                store.display()
            ),
        },
        other => other.map(str::to_owned),
    };
    let slice = Slice {
        filter: &filter,
        engine: engine.as_deref(),
    };
    let keep = |r: &Obj| {
        filter.keeps(r)
            && engine
                .as_ref()
                .is_none_or(|e| craft_store::retro::engine_key(r).is_ok_and(|k| k == *e))
    };
    let retro = retro_walk(store, &keep, Some(&slice), skipped)?;
    if let Some(e) = engine.as_deref()
        && retro.runs + retro.develop.cycles + retro.develop.unreadable == 0
    {
        bail!(
            "no finished run matches engine \"{e}\"; the store's engines:\n{}",
            engines(store)?
        );
    }
    render::retro(out, &slice, &retro, json)?;
    Ok(())
}

/// The engines of the store's records, each once in order, one `- <engine>` a line.
fn engines(store: &Path) -> Result<String> {
    let mut seen = std::collections::BTreeSet::new();
    read::records(store, &mut Skipped::default(), |_, r| {
        if r.get("schemaVersion").is_some_and(Js::truthy)
            && r.text_units("kind") != craft_store::retro::DONE_KIND
        {
            seen.insert(
                craft_store::retro::engine_key(&r).unwrap_or_else(|_| "(not Unicode)".into()),
            );
        }
    })
    .with_context(|| format!("reading {}", store.display()))?;
    Ok(seen
        .into_iter()
        .map(|e| format!("- {e}"))
        .collect::<Vec<_>>()
        .join("\n"))
}

/// The engine of the newest finished run `filter` keeps — no develop cycle nor a retro's mark —
/// `None` when it keeps none. The walk after it says what it passed over.
fn latest_engine(store: &Path, filter: &craft_store::filter::Filter) -> Result<Option<String>> {
    let mut newest: Option<(craft_store::js::JsString, Obj)> = None;
    read::records(store, &mut Skipped::default(), |_, r| {
        let live = r.get("schemaVersion").is_some_and(Js::truthy)
            && !r.get("partial").is_some_and(Js::truthy)
            && craft_store::retro::is_run(&r)
            && filter.keeps(&r);
        let ts = r
            .get("ts")
            .map_or_else(|| "undefined".into(), Js::to_js_text);
        if live && newest.as_ref().is_none_or(|(at, _)| ts > *at) {
            newest = Some((ts, r));
        }
    })
    .with_context(|| format!("reading {}", store.display()))?;
    Ok(newest
        .map(|(_, r)| craft_store::retro::engine_key(&r))
        .transpose()?)
}
