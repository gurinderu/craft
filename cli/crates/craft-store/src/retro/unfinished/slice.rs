//! Whether a record of a run that did not finish is inside what a retro keeps (realm @nick/craft,
//! nodes #61, #313), as the retired `partial-slice.mjs` judged it: a rebuilt record carries no craft version
//! of its own, a recovered one carries it in each phase checkpoint, and its top-level revision is
//! the recovering craft's, so the run's own comes first. Without a version a slice by version
//! cannot tell: the record is counted unattributed, never listed nor dropped in silence.

use std::collections::BTreeSet;

use crate::filter::Filter;
use crate::js::{Js, JsString, Obj};

/// What a retro keeps: its filters, and the engine `--engine` names, if any.
#[derive(Debug, Clone, Copy)]
pub struct Slice<'a> {
    pub filter: &'a Filter,
    pub engine: Option<&'a str>,
}

impl Slice<'_> {
    /// Whether the slice keeps every record.
    #[must_use]
    pub fn is_whole(&self) -> bool {
        *self.filter == Filter::default() && self.engine.is_none()
    }
}

fn phases(r: &Obj) -> &[Js] {
    r.get("phases").and_then(Js::as_arr).unwrap_or(&[])
}

/// The craft version a record names, or the one all its phase checkpoints agree on.
#[must_use]
pub fn version(r: &Obj) -> Option<JsString> {
    let own = r.text_units("craftVersion");
    if !own.is_empty() {
        return Some(own);
    }
    let seen: BTreeSet<JsString> = phases(r)
        .iter()
        .filter_map(Js::as_obj)
        .map(|p| p.text_units("craftVersion"))
        .filter(|v| !v.is_empty())
        .collect();
    (seen.len() == 1).then(|| seen.into_iter().next()).flatten()
}

fn integer(v: Option<&Js>) -> Option<f64> {
    v.and_then(Js::as_num)
        .filter(|n| n.is_finite() && n.fract() == 0.0)
}

/// The revision of the engine that ran the record's run (`runRevision`).
fn revision(r: &Obj) -> Option<f64> {
    if let Some(n) = integer(r.get("runEngineRevision")) {
        return Some(n);
    }
    let seen: Vec<f64> = phases(r)
        .iter()
        .filter_map(Js::as_obj)
        .filter_map(|p| {
            integer(p.get("workflowEngineRevision")).or_else(|| integer(p.get("engineRevision")))
        })
        .fold(Vec::new(), |mut seen, n| {
            if !seen.contains(&n) {
                seen.push(n);
            }
            seen
        });
    match seen.as_slice() {
        [one] => Some(*one),
        [] => integer(r.get("workflowEngineRevision")).or_else(|| integer(r.get("engineRevision"))),
        _ => None,
    }
}

/// An engine key's runtime, version and revision (`parseEngineKey`); `None` for a key no record
/// could carry. The outer `Option` of the revision is whether it parsed.
#[must_use]
pub fn engine_parts(key: &str) -> Option<(&str, Option<&str>, Option<f64>)> {
    let (runtime, rest) = key.split_once(' ')?;
    let (version, token) = rest.rsplit_once(' ')?;
    let revision = match token {
        "r?" => None,
        t => {
            let n: f64 = t.strip_prefix('r')?.parse().ok()?;
            (n.fract() == 0.0 && format!("r{}", crate::js::number_text(n)) == t).then_some(n)?;
            Some(n)
        }
    };
    Some((
        runtime,
        (version != "unversioned").then_some(version),
        revision,
    ))
}

/// Whether the engine of `r` is `want`'s: `None` when its version is unknown and the rest does
/// not rule it out.
fn engine_in(r: &Obj, version: Option<&JsString>, want: &str) -> Option<bool> {
    let (runtime, want_version, want_revision) = engine_parts(want)?;
    let own = match r.get("runtime") {
        Some(v) if v.truthy() => v.to_js_text(),
        _ => "unknown-runtime".into(),
    };
    let own = JsString::join(
        &[
            own,
            if super::super::is_cli(r) { "+cli" } else { "" }.into(),
        ],
        "",
    );
    if own != *runtime || revision(r) != want_revision {
        return Some(false);
    }
    match (version, want_version) {
        (None, None) => Some(true),
        (None, Some(_)) => None,
        (Some(v), w) => Some(w.is_some_and(|w| *v == *w)),
    }
}

/// Whether `r` is inside `slice`: `None` when its version is unknown and nothing else rules it out.
#[must_use]
pub fn inside(r: &Obj, slice: &Slice<'_>) -> Option<bool> {
    let version = version(r);
    let mut view = Obj::new();
    for k in ["project", "branch", "name", "ts", "verdict"] {
        if let Some(v) = r.get(k) {
            view.set(k, v.clone());
        }
    }
    let wanted = slice.filter.version.as_ref();
    match (&version, wanted) {
        (Some(v), _) => view.set("craftVersion", Js::Str(v.clone())),
        (None, Some(w)) => view.set("craftVersion", Js::str(w)),
        (None, None) => {}
    }
    if !slice.filter.keeps(&view) {
        return Some(false);
    }
    let engine = slice
        .engine
        .map_or(Some(true), |e| engine_in(r, version.as_ref(), e));
    match (engine, version.is_none() && wanted.is_some()) {
        (Some(false), _) => Some(false),
        (None, _) | (Some(true), true) => None,
        (Some(true), false) => Some(true),
    }
}
