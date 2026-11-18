//! The list's order and budgets: same crate first and tests last, each symbol taken in turn
//! when lines are cut — to the saved list's hard cap, and to the lenses' budget.

use std::path::Path;

use super::symbols::{Symbol, is_test_path};
use super::{Listed, Site};

/// How many lines one symbol keeps.
pub(super) const PER_SYMBOL: usize = 10;
/// How many lines the whole list keeps.
pub(super) const RUN_MAX: usize = 80;
/// How many lines the saved list holds at most.
pub(super) const FILE_MAX: usize = 1000;

/// The repository-relative directory of the crate holding `file`: the nearest one above it with
/// a `Cargo.toml`; empty at the top.
fn crate_dir(top: &Path, file: &str) -> String {
    let mut dir = Path::new(file).parent();
    while let Some(d) = dir.filter(|d| !d.as_os_str().is_empty()) {
        if top.join(d).join("Cargo.toml").is_file() {
            return d.display().to_string();
        }
        dir = d.parent();
    }
    String::new()
}

/// Same crate first, tests last, then by place.
pub(super) fn rank(top: &Path, sym: &Symbol, sites: &mut [Site]) {
    let home = crate_dir(top, &sym.file);
    let away = |f: &str| !home.is_empty() && !f.starts_with(&format!("{home}/"));
    sites.sort_by(|a, b| {
        let key = |s: &Site| (is_test_path(&s.file), away(&s.file));
        key(a)
            .cmp(&key(b))
            .then_with(|| (&a.file, a.line).cmp(&(&b.file, b.line)))
    });
}

/// Cuts each symbol to `per` lines and all of them to `max`, taking one line of
/// each symbol in turn so a late symbol is not starved; how many lines were cut.
pub(super) fn budget(symbols: &mut [Listed], per: usize, max: usize) -> usize {
    let total: usize = symbols.iter().map(|s| s.sites.len()).sum();
    let mut keep = vec![0usize; symbols.len()];
    let mut kept = 0;
    let rounds = symbols.iter().map(|s| s.sites.len()).max().unwrap_or(0);
    for round in 0..rounds.min(per) {
        for (k, s) in keep.iter_mut().zip(symbols.iter()) {
            if kept < max && s.sites.len() > round {
                *k += 1;
                kept += 1;
            }
        }
    }
    for (s, k) in symbols.iter_mut().zip(keep) {
        s.sites.truncate(k);
    }
    total - kept
}
