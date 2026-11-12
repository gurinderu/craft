//! The packing a unit batch is cut by: first-fit decreasing into bins of a volume, and a unit over
//! the budget alone split by module directory (`binPack`, `splitModules` and `moduleUnits` in
//! `lib/unit-batches.mjs`).

use std::collections::BTreeMap;

use super::Graph;
use crate::units::dirs::group_key;
use crate::units::scope::unit_slice_key;

/// How deep a module split descends.
const MAX_DEPTH: usize = 8;

/// One item to pack: a key, its files, its weight.
#[derive(Clone)]
pub(super) struct Piece {
    pub(super) key: String,
    pub(super) files: Vec<String>,
    pub(super) w: u64,
}

/// First-fit decreasing into bins of `cap`; an item heavier than `cap` gets a bin of its own.
pub(super) fn bin_pack(mut items: Vec<Piece>, cap: u64) -> Vec<Vec<Piece>> {
    items.sort_by(|a, b| b.w.cmp(&a.w).then_with(|| a.key.cmp(&b.key)));
    let mut bins: Vec<(Vec<Piece>, u64)> = Vec::new();
    for it in items {
        if let Some(bin) = bins.iter_mut().find(|b| b.1 + it.w <= cap) {
            bin.1 += it.w;
            bin.0.push(it);
        } else {
            let w = it.w;
            bins.push((vec![it], w));
        }
    }
    let mut out: Vec<Vec<Piece>> = bins
        .into_iter()
        .map(|(mut b, _)| {
            b.sort_by(|x, y| x.key.cmp(&y.key));
            b
        })
        .collect();
    out.sort_by(|x, y| x.first().map(|p| &p.key).cmp(&y.first().map(|p| &p.key)));
    out
}

/// A unit's files cut by module directory until each piece is under `cap`.
fn split_modules(piece: Piece, g: &Graph<'_>, cap: u64, depth: usize) -> Vec<Piece> {
    if piece.w <= cap || piece.files.len() <= 1 || depth > MAX_DEPTH {
        return vec![piece];
    }
    let mut by_key: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for f in &piece.files {
        by_key
            .entry(group_key(f, depth))
            .or_default()
            .push(f.clone());
    }
    if by_key.len() <= 1 {
        return split_modules(piece, g, cap, depth + 1);
    }
    by_key
        .into_iter()
        .flat_map(|(key, files)| {
            let w = g.lines_of(&files);
            split_modules(Piece { key, files, w }, g, cap, depth + 1)
        })
        .collect()
}

/// A unit over the budget alone: its module pieces packed into bins of `cap`.
pub(super) fn module_units(
    root: &str,
    files: &[String],
    g: &Graph<'_>,
    cap: u64,
) -> Vec<(String, Vec<String>)> {
    let depth = if root == "." {
        0
    } else {
        root.split('/').count()
    } + 1;
    let whole = Piece {
        key: root.to_owned(),
        files: files.to_vec(),
        w: g.lines_of(files),
    };
    let sub = |p: &Piece| {
        let k = unit_slice_key(root, &p.key);
        k.strip_prefix(&format!("unit:{root}//"))
            .unwrap_or(&k)
            .to_owned()
    };
    bin_pack(split_modules(whole, g, cap, depth), cap)
        .into_iter()
        .map(|bin| {
            let key = match bin.as_slice() {
                [one] => unit_slice_key(root, &one.key),
                _ => format!(
                    "unit:{root}//{}",
                    bin.iter().map(sub).collect::<Vec<_>>().join("+")
                ),
            };
            (key, bin.into_iter().flat_map(|p| p.files).collect())
        })
        .collect()
}
