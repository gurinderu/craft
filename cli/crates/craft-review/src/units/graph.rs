//! The unit graph the batching walks (`lib/unit-graph.mjs`): each unit as discovery sized it, the
//! dependency edges among the touched ones by name, and the public-signature lines a batch may read
//! in the units it depends on.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

/// A unit as discovery found it: its root, its name, its public lines and its dependencies' names,
/// names kept as Cargo matches them (`-` taken as `_`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Package {
    pub root: String,
    pub name: String,
    pub sig_lines: u64,
    pub deps: Vec<String>,
}

/// The dependency edges among `roots`, undirected and sorted.
#[must_use]
pub fn unit_edges(roots: &[String], packages: &[Package]) -> BTreeMap<String, Vec<String>> {
    let among: BTreeSet<&str> = roots.iter().map(String::as_str).collect();
    let root_of: BTreeMap<&str, &str> = packages
        .iter()
        .filter(|p| among.contains(p.root.as_str()))
        .map(|p| (p.name.as_str(), p.root.as_str()))
        .collect();
    let mut adj: BTreeMap<String, BTreeSet<String>> =
        roots.iter().map(|r| (r.clone(), BTreeSet::new())).collect();
    for p in packages.iter().filter(|p| among.contains(p.root.as_str())) {
        for d in &p.deps {
            let Some(q) = root_of.get(d.as_str()).filter(|q| **q != p.root) else {
                continue;
            };
            adj.entry(p.root.clone())
                .or_default()
                .insert((*q).to_owned());
            adj.entry((*q).to_owned())
                .or_default()
                .insert(p.root.clone());
        }
    }
    adj.into_iter()
        .map(|(r, s)| (r, s.into_iter().collect()))
        .collect()
}

/// The public-signature lines a batch of `members` may read in its dependencies: every discovered
/// unit one of them depends on, outside the batch, counted once.
#[must_use]
pub fn dep_sig_lines(members: &[String], packages: &[Package]) -> u64 {
    let in_batch: BTreeSet<&str> = members.iter().map(String::as_str).collect();
    let deps: BTreeSet<&str> = packages
        .iter()
        .filter(|p| in_batch.contains(p.root.as_str()))
        .flat_map(|p| p.deps.iter().map(String::as_str))
        .collect();
    deps.iter()
        .filter_map(|d| packages.iter().find(|p| p.name == *d))
        .filter(|p| !in_batch.contains(p.root.as_str()))
        .map(|p| p.sig_lines)
        .sum()
}

/// The connected components of `roots`, each breadth-first from its first root.
#[must_use]
pub fn components(roots: &[String], adj: &BTreeMap<String, Vec<String>>) -> Vec<Vec<String>> {
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut out = Vec::new();
    for r in roots {
        if !seen.insert(r.clone()) {
            continue;
        }
        let mut comp = vec![r.clone()];
        let mut i = 0;
        while let Some(at) = comp.get(i).cloned() {
            for n in adj.get(&at).into_iter().flatten() {
                if seen.insert(n.clone()) {
                    comp.push(n.clone());
                }
            }
            i += 1;
        }
        out.push(comp);
    }
    out
}
