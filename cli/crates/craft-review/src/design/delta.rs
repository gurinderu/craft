//! The crate dependency delta a Rust change makes, the design lens's seed (realm @nick/craft,
//! node #534): the edges among the workspace's own packages at the base and at the head, read from
//! their manifests, the edges the change adds and the cycles those close. Crate level only: module
//! edges would need the sources parsed, and a module cycle is legal Rust.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::Path;

use toml::Table;

use crate::git;
use crate::units::discover::{deps_in, name_key};

/// A dependency edge between two workspace packages, and whether it is a dev-dependency only.
type Edges = BTreeMap<(String, String), bool>;

/// The edges among the packages the manifests `texts` declare: a normal or build dependency, or a
/// dev-dependency only (Cargo allows a cycle through one). A text that does not parse, or declares
/// no package, adds none.
pub(super) fn edges(texts: &[String]) -> Edges {
    let manifests: Vec<(String, Table)> = texts
        .iter()
        .filter_map(|t| t.parse::<Table>().ok())
        .filter_map(|m| {
            let name = m.get("package")?.get("name")?.as_str()?.to_owned();
            Some((name_key(&name), m))
        })
        .collect();
    let members: BTreeSet<&str> = manifests.iter().map(|(n, _)| n.as_str()).collect();
    let mut out = Edges::new();
    for (from, m) in &manifests {
        let normal = deps_in(m, &["dependencies", "build-dependencies"]);
        for to in deps_in(
            m,
            &["dependencies", "build-dependencies", "dev-dependencies"],
        ) {
            if to != *from && members.contains(to.as_str()) {
                out.insert((from.clone(), to.clone()), !normal.contains(&to));
            }
        }
    }
    out
}

/// A path from `from` to `to` along `edges`, both ends included, the shortest.
fn path(edges: &Edges, from: &str, to: &str) -> Option<Vec<String>> {
    let mut back: BTreeMap<&str, &str> = BTreeMap::new();
    let mut queue = VecDeque::from([from]);
    while let Some(at) = queue.pop_front() {
        if at == to {
            let mut out = vec![to.to_owned()];
            let mut cur = to;
            while let Some(prev) = back.get(cur) {
                out.push((*prev).to_owned());
                cur = prev;
            }
            out.reverse();
            return Some(out);
        }
        for ((a, b), _) in edges.range((at.to_owned(), String::new())..) {
            if a != at {
                break;
            }
            if b != from && !back.contains_key(b.as_str()) {
                back.insert(b, at);
                queue.push_back(b);
            }
        }
    }
    None
}

fn kind(dev: bool) -> &'static str {
    if dev { " (dev-dependency)" } else { "" }
}

/// What the change does to the crate graph, one line each: every edge the head has and the base
/// had not, then every cycle such an edge closes, once per set of crates.
pub(super) fn lines(base: &Edges, head: &Edges) -> Vec<String> {
    let new: Vec<(&(String, String), bool)> = head
        .iter()
        .filter(|(e, _)| !base.contains_key(*e))
        .map(|(e, dev)| (e, *dev))
        .collect();
    let mut out: Vec<String> = new
        .iter()
        .map(|((a, b), dev)| format!("new edge: {a} -> {b}{}", kind(*dev)))
        .collect();
    let mut seen: BTreeSet<Vec<String>> = BTreeSet::new();
    for ((a, b), dev) in &new {
        let Some(back) = path(head, b, a) else {
            continue;
        };
        let mut members = back.clone();
        members.sort();
        if seen.insert(members) {
            out.push(format!(
                "new cycle: {a} -> {} (closed by the new edge {a} -> {b}{})",
                back.join(" -> "),
                kind(*dev)
            ));
        }
    }
    out
}

/// The manifests of the tree: at `rev` when given (each read with `git show`), else the working
/// tree's tracked ones.
fn manifests(top: &Path, rev: Option<&str>) -> Result<Vec<String>, String> {
    let listed = match rev {
        Some(r) => git::git(top, &["ls-tree", "-r", "--name-only", r]),
        None => git::git(top, &["ls-files"]),
    }
    .map_err(|e| e.to_string())?;
    let paths = listed
        .lines()
        .filter(|p| *p == "Cargo.toml" || p.ends_with("/Cargo.toml"));
    Ok(paths
        .filter_map(|p| match rev {
            Some(r) => git::git(top, &["show", &format!("{r}:{p}")]).ok(),
            None => std::fs::read_to_string(top.join(p)).ok(),
        })
        .collect())
}

/// The crate delta of the change from `merge_base` to the working tree at `top`.
///
/// # Errors
/// When git cannot list either side's manifests.
pub(super) fn read(top: &Path, merge_base: &str) -> Result<Vec<String>, String> {
    let base = edges(&manifests(top, Some(merge_base))?);
    let head = edges(&manifests(top, None)?);
    Ok(lines(&base, &head))
}
