//! The directory slicing files outside every unit keep (`sliceDiff` and its helpers in
//! `lib/lens-scope.mjs`): shared files ride on every slice, the owned ones are grouped by directory,
//! a group over the cap is split deeper, and the nearest groups are merged down to the slice count.

use std::collections::BTreeMap;

use super::Slice;
use merge::merge_nearest;

mod merge;

/// Files whose relation to everything else is the point, pulled into every slice.
const SHARED_SUFFIXES: [&str; 5] = [".lock", ".yml", ".yaml", ".toml", ".json"];
/// The directory depth a group is keyed on.
const GROUP_DEPTH: usize = 2;
/// How deep a split descends before it stops.
const MAX_DEPTH: usize = 8;
/// How many shared files ride along in every slice.
const MAX_SHARED_PER_SLICE: usize = 8;

/// Whether `file` is a manifest, lockfile or schema every slice carries.
#[must_use]
pub fn is_shared(file: &str) -> bool {
    SHARED_SUFFIXES.iter().any(|s| file.ends_with(s))
}

/// The directory of `file` to `depth` segments; its parent (`.` at the root) when shallower.
#[must_use]
pub fn group_key(file: &str, depth: usize) -> String {
    let parts: Vec<&str> = file.split('/').collect();
    if parts.len() <= depth {
        let parent = parts.get(..parts.len().saturating_sub(1)).unwrap_or(&[]);
        let key = parent.join("/");
        return if key.is_empty() { ".".into() } else { key };
    }
    parts.get(..depth).unwrap_or(&[]).join("/")
}

/// The changed files split into those riding along in every slice and those partitioned: shared
/// wins over owned, and a shared file the cap evicted that the profile owns is partitioned.
#[must_use]
pub fn partition_owned(all: &[String], owns: &dyn Fn(&str) -> bool) -> (Vec<String>, Vec<String>) {
    let mut shared_all: Vec<&String> = all.iter().filter(|f| is_shared(f)).collect();
    shared_all.sort_by(|a, b| {
        (a.split('/').count(), a.as_str()).cmp(&(b.split('/').count(), b.as_str()))
    });
    let shared = shared_all
        .iter()
        .take(MAX_SHARED_PER_SLICE)
        .map(|f| (*f).clone())
        .collect();
    let evicted = shared_all
        .iter()
        .skip(MAX_SHARED_PER_SLICE)
        .filter(|f| owns(f))
        .map(|f| (*f).clone());
    let owned = all
        .iter()
        .filter(|f| owns(f) && !is_shared(f))
        .cloned()
        .chain(evicted)
        .collect();
    (shared, owned)
}

/// `files` bucketed by their directory to `depth`, in key order.
fn by_key(files: &[String], depth: usize) -> BTreeMap<String, Vec<String>> {
    let mut out: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for f in files {
        out.entry(group_key(f, depth)).or_default().push(f.clone());
    }
    out
}

/// One group over `cap` split by descending into deeper directories (`splitDeep`).
#[must_use]
pub fn split_deep(
    key: &str,
    files: &[String],
    cap: usize,
    depth: usize,
) -> Vec<(String, Vec<String>)> {
    let whole = || vec![(key.to_owned(), files.to_vec())];
    if files.len() <= cap || depth > MAX_DEPTH {
        return whole();
    }
    let groups = by_key(files, depth);
    if groups.len() <= 1 {
        let deeper = split_deep(key, files, cap, depth + 1);
        return if deeper.len() > 1 { deeper } else { whole() };
    }
    groups
        .into_iter()
        .flat_map(|(k, fs)| split_deep(&k, &fs, cap, depth + 1))
        .collect()
}

/// Largest group first, then by key.
fn largest_first(a: &(String, Vec<String>), b: &(String, Vec<String>)) -> std::cmp::Ordering {
    b.1.len().cmp(&a.1.len()).then_with(|| a.0.cmp(&b.0))
}

/// The directory slices of `files` (`sliceDiff`); empty — "do not slice" — with fewer owned files
/// than `min_files` or a single directory group. Each slice carries the shared files.
#[must_use]
pub fn slice_diff(
    files: &[String],
    min_files: usize,
    max_slices: usize,
    owns: &dyn Fn(&str) -> bool,
) -> Vec<Slice> {
    let (shared, owned) = partition_owned(files, owns);
    if owned.len() < min_files {
        return Vec::new();
    }
    let groups = by_key(&owned, GROUP_DEPTH);
    if groups.len() <= 1 {
        return Vec::new();
    }
    let cap = owned.len().div_ceil(max_slices.max(1)).max(1);
    let mut split: Vec<(String, Vec<String>)> = groups
        .into_iter()
        .flat_map(|(k, fs)| split_deep(&k, &fs, cap, GROUP_DEPTH + 1))
        .collect();
    split.sort_by(largest_first);
    let mut merged = merge_nearest(split, max_slices, cap);
    merged.sort_by(largest_first);
    merged
        .into_iter()
        .map(|(key, fs)| Slice::loose(key, [fs, shared.clone()].concat()))
        .collect()
}

#[cfg(test)]
mod tests;
