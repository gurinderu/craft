//! What the memory's bounds keep when a run holds more than they let through (realm @nick/craft,
//! nodes #203, #218, #230): the recall prompt's changed paths grouped by directory instead of cut,
//! the records past the cap ranked by how close their scope is to the reviewed paths, and the
//! judges' pairs ranked so the reviewed paths, then every finding's best candidate, come first.
//! Under its bound each list is left exactly as it was.

use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use super::record::{scope_parts, text};

/// The recall prompt's entries for `paths` under `max`: the paths themselves when they fit, else
/// each cut to its leading directories (`dir/`), as deep as still fits; past `max` top-level
/// entries, the first `max` of them. Returns the entries, how many paths a directory entry stands
/// for, and how many paths no entry covers.
pub(super) fn path_entries(paths: &[String], max: usize) -> (Vec<String>, usize, usize) {
    if paths.len() <= max {
        return (paths.to_vec(), 0, 0);
    }
    let deepest = paths
        .iter()
        .map(|p| scope_parts(p).len())
        .max()
        .unwrap_or(1);
    let at =
        |depth: usize| -> BTreeSet<String> { paths.iter().map(|p| cut_to(p, depth)).collect() };
    let depth = (1..deepest)
        .rev()
        .find(|&d| at(d).len() <= max)
        .unwrap_or(1);
    let entries: Vec<String> = at(depth).into_iter().take(max).collect();
    // Entries are built from normalised segments, so a path is compared in the same form.
    let covered = |p: &str| {
        entries.iter().any(|e| {
            e == p
                || e.strip_suffix('/')
                    .is_some_and(|d| p.starts_with(&format!("{d}/")))
        })
    };
    let normal: Vec<String> = paths.iter().map(|p| scope_parts(p).join("/")).collect();
    let grouped = normal
        .iter()
        .filter(|p| covered(p) && !entries.contains(p))
        .count();
    let cut = normal.iter().filter(|p| !covered(p)).count();
    (entries, grouped, cut)
}

/// `path` cut to its first `depth` segments, as `dir/`; unchanged when it is no deeper.
fn cut_to(path: &str, depth: usize) -> String {
    let parts = scope_parts(path);
    if parts.len() <= depth {
        return parts.join("/");
    }
    format!("{}/", parts.get(..depth).unwrap_or(&[]).join("/"))
}

/// How close a record's scope is to the reviewed `paths`, lowest first: naming one of them, a
/// directory holding one, any other scope, the whole repository.
fn closeness(scope: &str, paths: &[String]) -> u8 {
    let parts = scope_parts(scope);
    if parts.is_empty() {
        return 3;
    }
    let holds = |p: &String| {
        let file = scope_parts(p);
        parts.len() <= file.len() && parts.iter().zip(&file).all(|(a, b)| a == b)
    };
    if paths.iter().any(|p| scope_parts(p) == parts) {
        0
    } else if paths.iter().any(holds) {
        1
    } else {
        2
    }
}

/// Which records of `list` a cap of `max` keeps, by index: all under it; past it the closest to
/// the reviewed `paths`, a deeper scope before a shallower one, a newer before an older, then the
/// order given.
pub(super) fn kept_records(list: &[Value], paths: &[String], max: usize) -> Vec<bool> {
    if list.len() <= max {
        return vec![true; list.len()];
    }
    let key = |i: usize| {
        let o = list.get(i).and_then(Value::as_object);
        let scope = o.map(|o| text(o.get("scope"))).unwrap_or_default();
        let date = o.map(|o| text(o.get("date"))).unwrap_or_default();
        (
            closeness(&scope, paths),
            Reverse(scope_parts(&scope).len()),
            Reverse(date),
            i,
        )
    };
    let mut order: Vec<usize> = (0..list.len()).collect();
    order.sort_by_cached_key(|&i| key(i));
    let mut kept = vec![false; list.len()];
    for &i in order.iter().take(max) {
        if let Some(k) = kept.get_mut(i) {
            *k = true;
        }
    }
    kept
}

/// A finding's severity as a rank, Critical first.
fn severity_rank(f: &Value) -> u8 {
    let s = f.get("severity").and_then(Value::as_str).unwrap_or("");
    match s.trim().to_lowercase().as_str() {
        "critical" => 0,
        "high" => 1,
        "medium" => 2,
        "low" => 3,
        _ => 4,
    }
}

/// Whether a finding is one the round reviews: a prior it re-adjudicates, or one whose file is
/// among the reviewed `paths` (every finding, when none are given).
pub(super) fn in_focus(f: &Value, paths: &[String]) -> bool {
    if paths.is_empty() || f.get("priorIndex").is_some() {
        return true;
    }
    let file = f.get("file").and_then(Value::as_str).unwrap_or("");
    paths.iter().any(|p| p == file)
}

/// A pair's place past the judge's bound: off the focus, the stage's group, the finding's nth
/// candidate, its severity, its place in the ranked order.
type PairKey = (bool, u8, usize, u8, usize);

/// The judge's `ranked` pairs (finding, record) reordered so the `max` it is asked about come
/// first, each part in the order it had: under the bound unchanged; past it those of findings in
/// focus first, then by `group` (the stage's own split of a pair (finding, record): whether the
/// record can set the finding aside), then every finding's first candidate before any finding's
/// second, then the more severe finding, then the order given.
pub(super) fn spread(
    ranked: Vec<(usize, usize)>,
    max: usize,
    findings: &[Value],
    paths: &[String],
    group: &dyn Fn(usize, usize) -> u8,
) -> Vec<(usize, usize)> {
    if ranked.len() <= max {
        return ranked;
    }
    let mut nth: BTreeMap<usize, usize> = BTreeMap::new();
    let mut keyed: Vec<(PairKey, (usize, usize))> = Vec::new();
    for (i, &(fi, di)) in ranked.iter().enumerate() {
        let k = nth.entry(fi).or_insert(0);
        let f = findings.get(fi).unwrap_or(&Value::Null);
        keyed.push((
            (!in_focus(f, paths), group(fi, di), *k, severity_rank(f), i),
            (fi, di),
        ));
        *k += 1;
    }
    keyed.sort_by_key(|(k, _)| *k);
    let mut sent: Vec<(usize, (usize, usize))> = Vec::new();
    let mut rest: Vec<(usize, (usize, usize))> = Vec::new();
    for (n, (k, p)) in keyed.into_iter().enumerate() {
        if n < max { &mut sent } else { &mut rest }.push((k.4, p));
    }
    sent.sort_by_key(|(i, _)| *i);
    rest.sort_by_key(|(i, _)| *i);
    sent.into_iter().chain(rest).map(|(_, p)| p).collect()
}

#[cfg(test)]
mod tests;
