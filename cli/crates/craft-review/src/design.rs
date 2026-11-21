//! The design lens's signal and seed (realm @nick/craft, node #534). A profile's part of the change
//! that adds a module, a crate, a public type or a format ([`signal`]) takes the `design` lens by
//! itself; `optional=design` buys it otherwise. What the signal saw, and for a Rust change the
//! crate graph's delta ([`delta`]), reach the lens's prompt as its seed — leads for its inventory
//! of decisions, never findings: a new edge is a decision to judge, not a defect.

use std::cell::Cell;
use std::collections::BTreeSet;
use std::path::Path;
use std::time::{Duration, Instant};

use crate::gate::lines::Lines;
use crate::git::Diff;
use crate::state::Track;

mod delta;
mod members;
mod seed;
mod signal;
mod types;

pub use seed::Seed;
pub(crate) use seed::lens_block;

/// The lens this module admits and seeds.
pub(crate) const LENS: &str = "design";
/// The profile whose design lens also reads the crate delta.
const RUST: &str = crate::consumers::PROFILE;

/// How many type names one run checks against the base, and for how long: a name past either is
/// taken as new.
const DECLARED_MAX: usize = 40;
const DECLARED_BUDGET: Duration = Duration::from_secs(10);

/// The directories among `dirs` the tree at `rev` lacks, each asked on its own (`git cat-file -e
/// <rev>:<dir>`: a pathspec list would let a child's entry hide its parent's).
fn new_dirs(top: &Path, rev: &str, dirs: &BTreeSet<&str>) -> BTreeSet<String> {
    dirs.iter()
        .filter(|d| **d != ".")
        .filter(|d| crate::git::git(top, &["cat-file", "-e", &format!("{rev}:{d}")]).is_err())
        .map(|d| (*d).to_owned())
        .collect()
}

/// Whether the tree at `rev` declares a type named `name` anywhere, within the run's budget: past
/// it, or when git cannot tell, it does not.
fn declared_at(top: &Path, rev: &str, asked: &Cell<(usize, Option<Instant>)>, name: &str) -> bool {
    let (n, since) = asked.get();
    let since = since.unwrap_or_else(Instant::now);
    asked.set((n + 1, Some(since)));
    if n >= DECLARED_MAX || since.elapsed() > DECLARED_BUDGET {
        return false;
    }
    let pattern = types::base_pattern(name);
    crate::git::git(top, &["grep", "-q", "-E", "-e", &pattern, rev, "--"]).is_ok()
}

/// Marks each of `tracks` whose part of `diff` adds structure, and returns the seed: each
/// profile's own lines, and, when the Rust profile takes part and a manifest changed, the crate
/// delta. The change is read from the checkout `cwd` is in; one that cannot be read marks none,
/// and the note it returns says so for the report.
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
    let asked = Cell::new((0, None));
    let ask = signal::Lookups {
        added_lines: &|f| lines.added_text(&top, f),
        new_dir: &|d| fresh.contains(d),
        declared: &|t| declared_at(&top, &diff.merge_base, &asked, t),
    };
    let mut seed = Seed::default();
    for t in tracks.iter_mut() {
        let part = signal::Part {
            rust: t.profile == RUST,
            files: &t.files,
            added: &added,
        };
        let reasons = signal::reasons(&part, &ask);
        t.design = !reasons.is_empty();
        if t.design {
            seed.structure.insert(t.profile.clone(), reasons);
        }
    }
    let rust = tracks.iter().any(|t| t.profile == RUST);
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
mod mark_tests;
#[cfg(test)]
mod seed_tests;
#[cfg(test)]
mod signal_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod types_tests;
