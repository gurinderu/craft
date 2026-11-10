//! Whether a held CI map entry can be kept (realm @nick/craft, node #482): `--write` checks an
//! entry as [`CiEntry::confirmed`] does, the gate skips one whose check no run is named or which
//! another job's runs collide with, and `--propose` names either reason on the held entry.

use std::path::Path;

use super::ci::{CiEntry, CiError, unexpanded};
use super::ci_files::{hashes, relative};

impl CiEntry {
    /// The entry checked under `top` as [`Self::confirmed`] does: `held` keeps its hashes, else its
    /// files are hashed now. A held one whose files changed is kept stale, its claims unread.
    pub(super) fn checked(self, top: &Path, held: bool) -> Result<Self, CiError> {
        let mut e = self;
        if unexpanded(&e.check) {
            return Err(CiError::Unexpanded(e.check));
        }
        if !held {
            relative(&e.workflow)?;
            e.sources.iter().try_for_each(|s| relative(s))?;
            e.lines()?;
            e.written(top)?;
            let files: Vec<&str> = std::iter::once(e.workflow.as_str())
                .chain(e.sources.iter().map(String::as_str))
                .collect();
            e.hashes = hashes(top, &e.workflow, &files)?;
        }
        e.check()?;
        if held && e.changed(top).is_empty() {
            e.written(top)?;
        }
        Ok(e)
    }

    /// Why the gate reads no runs for this entry, stale or not, whatever its files: its check
    /// holds an unexpanded `${{ … }}`, which no run is named, or the workflows under `top` refuse
    /// its check as `--write` would — another job claims its runs, or it names one expanded run.
    #[must_use]
    pub fn unmatched(&self, top: &Path) -> Option<CiError> {
        if unexpanded(&self.check) {
            return Some(CiError::Unexpanded(self.check.clone()));
        }
        self.claims(top).err()
    }

    /// Why this held entry cannot be kept as it is: the gate's [`Self::unmatched`] reason, else the
    /// refusal `--write` gives it passed back as `ci` prints it. A fresh confirmation of it is
    /// refused the same; a stale entry that is neither is kept, and only confirmed again.
    #[must_use]
    pub fn unusable(&self, top: &Path) -> Option<CiError> {
        self.unmatched(top)
            .or_else(|| self.clone().checked(top, true).err())
    }
}
