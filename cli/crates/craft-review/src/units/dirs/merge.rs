//! How the directory groups are merged down to the slice count (`mergeNearestGroups` and its
//! helpers in `lib/lens-scope.mjs`): the cap outranks kinship, and among the merges under it the
//! nearest siblings, then the smallest, go first.

/// How many leading path segments two keys share.
fn common_prefix(a: &str, b: &str) -> usize {
    a.split('/')
        .zip(b.split('/'))
        .take_while(|(x, y)| x == y)
        .count()
}

/// The pair to merge: under the cap the closest (most shared segments, then smallest), else the
/// smallest pair.
fn pick_merge(groups: &[(String, Vec<String>)], cap: usize) -> (usize, usize) {
    let mut best: Option<(usize, usize, usize, usize)> = None;
    let mut fallback: Option<(usize, usize, usize)> = None;
    for (i, (ki, fi)) in groups.iter().enumerate() {
        for (j, (kj, fj)) in groups.iter().enumerate().skip(i + 1) {
            let (shared, size) = (common_prefix(ki, kj), fi.len() + fj.len());
            if fallback.is_none_or(|f| size < f.2) {
                fallback = Some((i, j, size));
            }
            let closer = best.is_none_or(|b| shared > b.2 || (shared == b.2 && size < b.3));
            if size <= cap && closer {
                best = Some((i, j, shared, size));
            }
        }
    }
    best.map(|b| (b.0, b.1))
        .or_else(|| fallback.map(|f| (f.0, f.1)))
        .unwrap_or((0, 1))
}

/// The key of two merged groups: their shared ancestor, or both.
fn merged_key(a: &str, b: &str) -> String {
    let n = common_prefix(a, b);
    if n > 0 {
        a.split('/').take(n).collect::<Vec<_>>().join("/")
    } else {
        format!("{a} + {b}")
    }
}

/// `key`, numbered when another group has it.
fn unique_key(key: String, groups: &[(String, Vec<String>)]) -> String {
    let taken = |k: &str| groups.iter().any(|g| g.0 == k);
    if !taken(&key) {
        return key;
    }
    (2..)
        .map(|n| format!("{key} ({n})"))
        .find(|k| !taken(k))
        .unwrap_or(key)
}

/// Groups merged nearest-first until no more than `max` remain.
pub(super) fn merge_nearest(
    mut groups: Vec<(String, Vec<String>)>,
    max: usize,
    cap: usize,
) -> Vec<(String, Vec<String>)> {
    while groups.len() > max.max(1) {
        let (i, j) = pick_merge(&groups, cap);
        let b = groups.remove(j);
        let a = groups.remove(i);
        let key = unique_key(merged_key(&a.0, &b.0), &groups);
        groups.push((key, [a.1, b.1].concat()));
    }
    groups
}
