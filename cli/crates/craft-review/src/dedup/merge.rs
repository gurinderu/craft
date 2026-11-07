//! The dedup's groups as one graph (`dedupPool`, `lib/review-same-spot.mjs`,
//! `lib/dedup-components.mjs`, realm @nick/craft, node #405): the same-spot groups and the model's
//! groups are edges over the pool, each connected component one finding, merged onto its strictest
//! member (`mergedGroup`). The CLI runs no gate, so no finding is a tool's and the engines'
//! tool-distinct rules have nothing to hold apart.

use std::collections::BTreeSet;

use serde_json::{Map, Value, json};

use super::{sev_rank, text, with_earliest_round};
use crate::harm::floor_note;
use crate::harm::raise::group_claims;

/// How alike two titles at one spot must be to be one defect, as `SAME_SPOT_OVERLAP`.
const SAME_SPOT_OVERLAP: f64 = 0.6;
/// The largest component chaining groups may build before it falls back to first-wins.
const COMPONENT_MAX: usize = 40;
/// The rank of Medium among severities.
const MEDIUM: usize = 2;

/// A title's words, lowercased, as a set (`titleShingle`).
fn shingle(title: &str) -> BTreeSet<String> {
    title
        .to_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_owned)
        .collect()
}

/// The share of words two titles have in common, of the larger set (`shingleOverlap`).
fn overlap(a: &str, b: &str) -> f64 {
    let (sa, sb) = (shingle(a), shingle(b));
    let most = sa.len().max(sb.len());
    if sa.is_empty() || sb.is_empty() {
        return 0.0;
    }
    let shared = sa.intersection(&sb).count();
    f64::from(u32::try_from(shared).unwrap_or(u32::MAX))
        / f64::from(u32::try_from(most).unwrap_or(u32::MAX))
}

/// Groups of findings at one `file:line` with near-identical titles, as `sameSpotGroups`.
fn same_spot_groups(pool: &[Value]) -> Vec<Vec<usize>> {
    let mut spots: Vec<(String, Vec<usize>)> = Vec::new();
    for (i, f) in pool.iter().enumerate() {
        let file = text(f, "file");
        if file.is_empty() {
            continue;
        }
        let k = format!(
            "{}:{}",
            file.to_lowercase(),
            f.get("line").and_then(Value::as_i64).unwrap_or(0)
        );
        match spots.iter_mut().find(|(s, _)| *s == k) {
            Some((_, at)) => at.push(i),
            None => spots.push((k, vec![i])),
        }
    }
    let mut groups = Vec::new();
    for (_, idxs) in spots.iter().filter(|(_, v)| v.len() > 1) {
        let mut taken = BTreeSet::new();
        for &i in idxs {
            if taken.contains(&i) {
                continue;
            }
            let title = |j: usize| pool.get(j).map_or("", |f| text(f, "title"));
            let mut g = vec![i];
            for &j in idxs {
                if j != i && !taken.contains(&j) && overlap(title(i), title(j)) >= SAME_SPOT_OVERLAP
                {
                    g.push(j);
                    taken.insert(j);
                }
            }
            if g.len() > 1 {
                taken.insert(i);
                groups.push(g);
            }
        }
    }
    groups
}

fn find(parent: &mut [usize], i: usize) -> usize {
    let mut r = i;
    while let Some(&p) = parent.get(r).filter(|&&p| p != r) {
        r = p;
    }
    let mut i = i;
    while let Some(&p) = parent.get(i).filter(|&&p| p != r) {
        if let Some(slot) = parent.get_mut(i) {
            *slot = r;
        }
        i = p;
    }
    r
}

/// The groups of `groups` that overlap no earlier one.
fn first_wins(groups: &[&Vec<usize>]) -> Vec<Vec<usize>> {
    let mut taken = BTreeSet::new();
    let mut out = Vec::new();
    for g in groups {
        if g.iter().any(|i| taken.contains(i)) {
            continue;
        }
        taken.extend(g.iter().copied());
        out.push((*g).clone());
    }
    out
}

/// The connected components of the edges `det` then `model` lay over `n` indices, as
/// `mergeComponents`; one over [`COMPONENT_MAX`] falls back to first-wins over its own groups.
fn components(n: usize, det: &[Vec<usize>], model: &[Vec<usize>]) -> Vec<Vec<usize>> {
    let all: Vec<&Vec<usize>> = det.iter().chain(model).collect();
    let mut parent: Vec<usize> = (0..n).collect();
    for g in &all {
        let Some(&head) = g.first() else { continue };
        for &i in g.iter().skip(1) {
            let (a, b) = (find(&mut parent, i), find(&mut parent, head));
            if let Some(slot) = parent.get_mut(a) {
                *slot = b;
            }
        }
    }
    let mut comps: Vec<(usize, Vec<usize>)> = Vec::new();
    for i in 0..n {
        let r = find(&mut parent, i);
        match comps.iter_mut().find(|(root, _)| *root == r) {
            Some((_, c)) => c.push(i),
            None => comps.push((r, vec![i])),
        }
    }
    let mut groups = Vec::new();
    for (root, members) in comps.into_iter().filter(|(_, m)| m.len() > 1) {
        if members.len() <= COMPONENT_MAX {
            groups.push(members);
            continue;
        }
        let own: Vec<&Vec<usize>> = all
            .iter()
            .filter(|g| g.first().is_some_and(|&h| find(&mut parent, h) == root))
            .copied()
            .collect();
        groups.extend(first_wins(&own));
    }
    groups
}

/// One same-defect group merged onto its worst member, as `mergedGroup`.
fn merged_group(members: &[&Value]) -> Value {
    let mut by_rank: Vec<&Value> = members.to_vec();
    by_rank.sort_by_key(|m| sev_rank(m));
    let Some(&base) = by_rank.first() else {
        return Value::Null;
    };
    let mut out: Map<String, Value> = base.as_object().cloned().unwrap_or_default();
    let floored = members
        .iter()
        .find(|m| !floor_note(text(m, "why")).is_empty() && sev_rank(m) < sev_rank(base));
    if let Some(fl) = floored.filter(|_| sev_rank(base) > MEDIUM) {
        out.insert("severity".into(), json!("Medium"));
        out.insert(
            "why".into(),
            json!(format!(
                "{}{}",
                text(base, "why"),
                floor_note(text(fl, "why"))
            )),
        );
    }
    let claims = group_claims(members.iter().copied());
    if claims.len() > 1 {
        out.insert("harmClaims".into(), Value::Array(claims));
    }
    // The foreign system a merged-away member named, when the base names none (node #430).
    let named = |m: &Value| {
        m.get("externalSystem")
            .filter(|e| !matches!(e, Value::Null | Value::Bool(false)) && e.as_str() != Some(""))
            .cloned()
    };
    if named(base).is_none()
        && let Some(e) = members.iter().find_map(|m| named(m))
    {
        out.insert("externalSystem".into(), e);
    }
    let mut sources: Vec<Value> = Vec::new();
    for m in members {
        let own = m.get("source").into_iter();
        let more = m
            .get("sources")
            .and_then(Value::as_array)
            .into_iter()
            .flatten();
        for s in own
            .chain(more)
            .filter(|s| s.as_str().is_some_and(|s| !s.is_empty()))
        {
            if !sources.contains(s) {
                sources.push(s.clone());
            }
        }
    }
    let mut checked: Vec<&str> = Vec::new();
    for w in members
        .iter()
        .map(|m| text(m, "whereChecked"))
        .filter(|w| !w.is_empty())
    {
        if !checked.contains(&w) {
            checked.push(w);
        }
    }
    let others: Vec<&str> = members
        .iter()
        .filter(|m| !std::ptr::eq(**m, base))
        .map(|m| text(m, "source"))
        .collect();
    let why = format!(
        "{} (same defect also reported by: {})",
        out.get("why").and_then(Value::as_str).unwrap_or(""),
        others.join(", ")
    );
    out.insert("sources".into(), Value::Array(sources));
    out.insert("whereChecked".into(), json!(checked.join("; ")));
    out.insert("why".into(), json!(why));
    with_earliest_round(Value::Object(out), members)
}

/// The pool with each same-defect component merged into one finding: the model's `groups`
/// (the dedup task's answer, `None` when it gave none) and the same-spot groups. Returns the pool
/// and how many duplicates it folded.
#[must_use]
pub(crate) fn merge(pool: &[Value], answer: Option<&Value>) -> (Vec<Value>, usize) {
    let n = pool.len();
    let model: Vec<Vec<usize>> = answer
        .and_then(|a| a.get("groups"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|g| {
            let g: Vec<usize> = g
                .as_array()?
                .iter()
                .map(|i| {
                    i.as_u64()
                        .and_then(|i| usize::try_from(i).ok())
                        .filter(|&i| i < n)
                })
                .collect::<Option<_>>()?;
            (g.len() > 1).then_some(g)
        })
        .collect();
    let groups = components(n, &same_spot_groups(pool), &model);
    if groups.is_empty() {
        return (pool.to_vec(), 0);
    }
    let in_group: BTreeSet<usize> = groups.iter().flatten().copied().collect();
    let mut out: Vec<Value> = pool
        .iter()
        .enumerate()
        .filter(|(i, _)| !in_group.contains(i))
        .map(|(_, f)| f.clone())
        .collect();
    for g in &groups {
        let members: Vec<&Value> = g.iter().filter_map(|&i| pool.get(i)).collect();
        out.push(merged_group(&members));
    }
    let folded = n - out.len();
    (out, folded)
}
