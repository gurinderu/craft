//! The touched units within the budget grouped into batches (`batchGroups` and `growAlongEdges` in
//! `lib/unit-batches.mjs`): a dependency-connected component whole when it fits, else grown along
//! its edges; what is left alone is bin-packed by volume.

use std::collections::{BTreeMap, BTreeSet};

use super::Graph;
use super::pack::{Piece, bin_pack};
use crate::units::graph::{components, unit_edges};

/// A component over the budget grown into batches along its edges.
fn grow_along_edges(
    comp: &[String],
    adj: &BTreeMap<String, Vec<String>>,
    vol: &dyn Fn(&str) -> u64,
    budget: u64,
) -> Vec<Vec<String>> {
    let mut placed: BTreeSet<String> = BTreeSet::new();
    let mut out = Vec::new();
    for seed in comp {
        if !placed.insert(seed.clone()) {
            continue;
        }
        let mut batch = vec![seed.clone()];
        let mut w = vol(seed);
        let mut i = 0;
        while let Some(at) = batch.get(i).cloned() {
            for n in adj.get(&at).into_iter().flatten() {
                if !placed.contains(n) && w + vol(n) <= budget {
                    placed.insert(n.clone());
                    batch.push(n.clone());
                    w += vol(n);
                }
            }
            i += 1;
        }
        out.push(batch);
    }
    out
}

/// The units within the budget grouped: each component whole when it fits, else grown along its
/// edges; what is left alone is bin-packed by volume.
pub(super) fn batch_groups(
    small: &[String],
    g: &Graph<'_>,
    vol: &dyn Fn(&str) -> u64,
    budget: u64,
) -> Vec<Vec<String>> {
    let adj = unit_edges(small, g.packages);
    let mut groups = Vec::new();
    let mut singles = Vec::new();
    for comp in components(small, &adj) {
        let fits = comp.iter().map(|r| vol(r)).sum::<u64>() <= budget;
        let parts = if fits {
            vec![comp]
        } else {
            grow_along_edges(&comp, &adj, vol, budget)
        };
        for mut p in parts {
            if let [one] = p.as_slice() {
                singles.push(Piece {
                    key: one.clone(),
                    files: Vec::new(),
                    w: vol(one),
                });
            } else {
                p.sort();
                groups.push(p);
            }
        }
    }
    let packed = bin_pack(singles, budget)
        .into_iter()
        .map(|bin| bin.into_iter().map(|p| p.key).collect());
    groups.into_iter().chain(packed).collect()
}
