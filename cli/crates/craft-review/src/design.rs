//! The design lens's signal and seed (realm @nick/craft, node #534). A profile's part of the change
//! that adds a module, a crate, a public type or a format ([`signal`]) takes the `design` lens by
//! itself; `optional=design` buys it otherwise. What the signal saw, and for a Rust change the
//! crate graph's delta ([`delta`]), reach the lens's prompt as its seed — leads for its inventory
//! of decisions, never findings: a new edge is a decision to judge, not a defect.

use std::collections::BTreeSet;
use std::path::Path;

use crate::gate::lines::Lines;
use crate::git::Diff;
use crate::state::Track;

mod delta;
mod seed;
mod signal;

pub use seed::Seed;
pub(crate) use seed::lens_block;

/// The lens this module admits and seeds.
pub(crate) const LENS: &str = "design";

/// The directories among `dirs` the tree at `rev` lacks, read with one `git ls-tree`; none when
/// git cannot tell (the signal then does not fire on a directory).
fn new_dirs(top: &Path, rev: &str, dirs: &BTreeSet<&str>) -> BTreeSet<String> {
    let asked: Vec<&str> = dirs.iter().copied().filter(|d| *d != ".").collect();
    if asked.is_empty() {
        return BTreeSet::new();
    }
    let mut args = vec!["ls-tree", "--name-only", rev, "--"];
    args.extend(&asked);
    let Ok(out) = crate::git::git(top, &args) else {
        return BTreeSet::new();
    };
    let have: BTreeSet<&str> = out.lines().collect();
    asked
        .into_iter()
        .filter(|d| !have.contains(d))
        .map(str::to_owned)
        .collect()
}

/// Marks each of `tracks` whose part of `diff` adds structure, and returns the seed; the change
/// read from the checkout `cwd` is in. A change that cannot be read marks none, and the note it
/// returns says so for the report.
pub(crate) fn mark(cwd: &Path, diff: &Diff, tracks: &mut [Track]) -> (Seed, Option<String>) {
    let read = crate::git::toplevel(cwd).and_then(|top| {
        crate::git::zero_context_diff(cwd, &diff.merge_base).map(|text| (top, text))
    });
    let (top, text) = match read {
        Ok(got) => got,
        Err(e) => {
            let note = format!(
                "the design signal could not be read ({e}): no profile was given the design lens \
                 for the modules, crates, public types or formats its change adds"
            );
            return (Seed::default(), Some(note));
        }
    };
    let (added, lines) = (signal::added_files(&text), Lines::parse(&text));
    let dirs: BTreeSet<&str> = added.iter().map(|f| signal::dir_of(f)).collect();
    let fresh = new_dirs(&top, &diff.merge_base, &dirs);
    let mut seed = Seed::default();
    for t in tracks.iter_mut() {
        let part = signal::Part {
            rust: t.profile == "rust",
            files: &t.files,
            added: &added,
        };
        let reasons = signal::reasons(&part, |f| lines.added_text(&top, f), |d| fresh.contains(d));
        t.design = !reasons.is_empty();
        seed.structure.extend(reasons);
    }
    let rust = tracks.iter().any(|t| t.profile == "rust");
    let manifests = diff
        .files
        .iter()
        .any(|f| f == "Cargo.toml" || f.ends_with("/Cargo.toml"));
    if rust && manifests {
        match delta::read(&top, &diff.merge_base) {
            Ok(crates) => seed.crates = crates,
            Err(e) => seed.note = format!("the crate graph could not be read ({e})"),
        }
    }
    (seed, None)
}

#[cfg(test)]
mod delta_tests;
#[cfg(test)]
mod seed_tests;
#[cfg(test)]
mod signal_tests;
#[cfg(test)]
mod tests;
