//! The list built: the change's symbols read from its zero-context diff, their consumers found,
//! or why no list could be built.

use std::path::Path;

use super::{Consumers, changed, list};
use crate::cancel::Cancel;

impl Consumers {
    /// A list that was not built, saying why.
    #[must_use]
    pub fn failed(why: impl Into<String>) -> Self {
        Self {
            failed: why.into(),
            ..Self::default()
        }
    }
}

/// The list for the change of the checkout `cwd` is in, its name search run until `cancel` is; a
/// list that says why it was not built when the checkout's top cannot be read.
#[must_use]
pub fn of_checkout(cwd: &Path, diff: &crate::git::Diff, cancel: &Cancel) -> Consumers {
    match crate::git::toplevel(cwd) {
        Ok(top) => build_until(&top, diff, cancel),
        Err(e) => Consumers::failed(format!("the checkout's top could not be read: {e}")),
    }
}

/// The list for the change of the working tree at `top` against `diff`'s merge-base (as the
/// lenses' diff), over its changed files; a list that says why it was not built when the
/// change's diff cannot be read.
#[must_use]
pub fn build(top: &Path, diff: &crate::git::Diff) -> Consumers {
    build_until(top, diff, &Cancel::default())
}

/// [`build`], its name search run until `cancel` is.
fn build_until(top: &Path, diff: &crate::git::Diff, cancel: &Cancel) -> Consumers {
    let text = match crate::git::zero_context_diff(top, &diff.merge_base) {
        Ok(text) => text,
        Err(e) => return Consumers::failed(format!("the change's diff could not be read: {e}")),
    };
    let changed = crate::gate::lines::Lines::parse(&text);
    let removed = crate::gate::lines::removals(&text);
    let found = changed::changed(top, &diff.files, &changed, &removed, list::SYMBOLS_MAX);
    let mut out = list::assemble(top, &changed, &found.symbols, cancel);
    out.unplaced = found.unplaced;
    out.unlisted = found.unlisted;
    out.unreadable = found.unreadable;
    out
}
