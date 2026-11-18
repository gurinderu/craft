//! The items a change only removes lines from: a pure deletion names the item holding both lines
//! it sat between; one no single item holds is kept as unplaced, so it is said rather than lost.

use super::braces::structure;
use super::symbols::{Symbol, add, enclosing, is_code, item};
use crate::gate::lines::Removal;

/// The symbols of one file's text `text` that its pure deletions `removals` change, each once; and
/// the deletions of code no item holds (`file:line (lines removed after it)`).
pub(super) fn of_removals(
    file: &str,
    text: &str,
    removals: &[&Removal],
) -> (Vec<Symbol>, Vec<String>) {
    let (mut out, mut unplaced) = (Vec::new(), Vec::new());
    if removals.is_empty() {
        return (out, unplaced);
    }
    let lines: Vec<&str> = text.lines().collect();
    let st = structure(&lines);
    for r in removals
        .iter()
        .filter(|r| r.text.iter().any(|l| is_code(l)))
    {
        // The lines it sat between, 0-based: `after` is the 1-based line above.
        let below = usize::try_from(r.after).unwrap_or(usize::MAX);
        let above = below.checked_sub(1).and_then(|a| enclosing(&lines, &st, a));
        let holder = above.filter(|&d| enclosing(&lines, &st, below) == Some(d));
        match holder {
            Some(d) => {
                if let Some(sym) = item(file, &lines, &st, d) {
                    add(&mut out, sym);
                }
            }
            None => unplaced.push(format!("{file}:{} (lines removed after it)", r.after)),
        }
    }
    (out, unplaced)
}
