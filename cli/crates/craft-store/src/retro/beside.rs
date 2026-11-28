//! What a retro sums of a finished run beside its workflow, kind, engine and lenses: the
//! workflow's [`super::Flow`], what the run did not do ([`super::signals`]), what it recalled,
//! how its doubtful findings ended, its depth, its memory contradictions, and whether its record
//! names the engine revision that ran it.

use crate::js::{Js, Obj, Utf16Error};

use super::Retro;
use super::plan::Input;

/// The revision token a record's engine carries: `r<N>`, or `r?` with none.
fn revision(r: &Obj) -> Option<String> {
    let int = |k: &str| r.get(k).and_then(Js::as_num).filter(|n| n.fract() == 0.0);
    int("workflowEngineRevision")
        .or_else(|| int("engineRevision"))
        .map(|n| format!("r{}", crate::js::number_text(n)))
}

/// Adds the run, added under `id`, to every sum beside its workflow's.
/// # Errors
/// When a field the sums key on cannot be represented as Unicode.
pub(super) fn add(out: &mut Retro, id: &str, r: &Obj) -> Result<(), Utf16Error> {
    out.signals.add(r)?;
    out.memory.add(r)?;
    out.sorting.add(r);
    super::depth::add(&mut out.depth, r);
    out.contradictions.add(id, r);
    let rev = revision(r);
    out.unattributed += u64::from(rev.is_none());
    if let Some(v) = r.get("craftVersion").filter(|v| v.truthy()) {
        out.revisions
            .entry(v.to_js_string()?)
            .or_default()
            .insert(rev.unwrap_or_else(|| "r?".to_owned()));
    }
    Ok(())
}

/// Adds the run to its workflow's [`super::Flow`]; a full-plan run is priced now, or with the
/// run's parts once every record is read when [`super::kinds::add`] deferred it past `waiting`.
/// # Errors
/// When a lens the surface gate dropped cannot be represented as Unicode.
pub(super) fn flow(out: &mut Retro, name: &str, r: &Obj, waiting: usize) -> Result<(), Utf16Error> {
    let full_plan = !super::depth::is_light(r);
    let flow = out.flows.entry(name.to_owned()).or_default();
    flow.add(r, full_plan)?;
    if !full_plan {
        return Ok(());
    }
    match out.deferred.get_mut(waiting) {
        Some(d) => d.flow = Some((name.to_owned(), Input::of(r))),
        None => flow.plan.add(&Input::of(r), r.get("cost")),
    }
    Ok(())
}
