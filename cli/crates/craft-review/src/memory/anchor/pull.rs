//! A record's pull requests (`pullLinks` in `integrations/shared/prior-decision-record.mjs`): the
//! GitHub pull request URLs among its links, and the merge on the trunk of the first that names
//! this repository, which anchors a record that names no commit (realm @nick/craft, node #682).

use std::cell::OnceCell;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::{Base, Unusable};
use crate::git;

mod link;
mod origin;
mod outside;

pub(in crate::memory) use link::pulls;

use origin::named;

/// A pull request a record links: its repository, `owner/name` lower-cased, and its number.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pull {
    pub repo: String,
    pub number: u64,
}

/// The repository a scope check runs in, its trunk and its origin each asked of git once, when
/// first needed.
pub(crate) struct Repo<'p> {
    pub(crate) path: &'p Path,
    trunk: OnceCell<Option<String>>,
    origin: OnceCell<Option<String>>,
}

impl<'p> Repo<'p> {
    pub(crate) fn new(path: &'p Path) -> Self {
        Self {
            path,
            trunk: OnceCell::new(),
            origin: OnceCell::new(),
        }
    }

    /// The trunk ([`git::trunk`]).
    pub(crate) fn trunk(&self) -> Option<&str> {
        self.trunk.get_or_init(|| git::trunk(self.path)).as_deref()
    }

    /// The first of `pulls` whose repository origin names: its URL, lower-cased, credentials
    /// before an `@` in an `https://` host and one trailing `/` dropped, is `https://github.com/`,
    /// `git@github.com:` or `ssh://git@github.com/` followed by the repository, `.git` after it or
    /// not. An ssh host alias or `www.github.com` names none: the record falls back to its date.
    fn ours<'a>(&self, pulls: &'a [Pull]) -> Option<&'a Pull> {
        let url = self.origin.get_or_init(|| git::origin_url(self.path));
        let rest = named(url.as_deref()?)?;
        pulls
            .iter()
            .find(|p| rest == p.repo || rest.strip_suffix(".git") == Some(p.repo.as_str()))
    }

    /// The merge on the trunk of the first of `pulls` of this repository and its number; `None`
    /// when none is of it, no trunk resolves, or no first-parent commit of the trunk's tip names
    /// it ([`git::merge_of`]), git failing included (realm @nick/craft, node #682).
    pub(super) fn merge(&self, pulls: &[Pull]) -> Option<(String, u64)> {
        let pull = self.ours(pulls)?;
        let tip = self.trunk()?;
        let commit = git::merge_of(self.path, tip, pull.number).ok()??;
        Some((commit, pull.number))
    }

    /// The base of a record anchored by `pulls`: the merge of the first of this repository
    /// ([`Repo::merge`]) with the base of its decision date `day` beside it ([`with_date`]);
    /// `Ok(None)` when no merge is found.
    ///
    /// # Errors
    /// [`Unusable::Unreadable`] when git fails listing the trunk before that day,
    /// [`Unusable::Missing`] when the trunk holds no commit before it.
    pub(super) fn merged(
        &self,
        pulls: &[Pull],
        day: Option<&str>,
        today: &str,
    ) -> Result<Option<Base>, Unusable> {
        let Some((commit, n)) = self.merge(pulls) else {
            return Ok(None);
        };
        let base = Base {
            commit,
            pull: Some(n),
            dated: None,
        };
        with_date(base, day.map(|d| super::dated(self, d, today))).map(Some)
    }
}

/// A merge's `base` with its decision date's base `dated` beside it, when the record names a day:
/// the scope must not have changed on the trunk between that day and the merge either (realm
/// @nick/craft, node #682). A day in the future leaves the merge alone to compare against; the
/// trunk holding no commit before the day (a shallow clone) or git failing to list it raises the
/// record, as it raises one anchored by its date alone.
fn with_date(mut base: Base, dated: Option<Result<String, Unusable>>) -> Result<Base, Unusable> {
    match dated {
        Some(Err(why @ (Unusable::Unreadable | Unusable::Missing))) => Err(why),
        Some(Ok(b)) => {
            base.dated = Some(b);
            Ok(base)
        }
        Some(Err(_)) | None => Ok(base),
    }
}

/// What a scope is said to have changed since when its base was the merge of pull request `n`.
pub(crate) fn since_merge(n: u64) -> String {
    format!("the merge of PR #{n}")
}

/// Where a scope is said to have changed when it changed on the trunk outside pull request `n`
/// before its merge: after the decision date, or where the request's branch lacked it.
pub(crate) fn before_merge(n: u64) -> String {
    format!("on the trunk outside the pull request before the merge of PR #{n}")
}

/// Why a record anchored by its pull requests alone names nothing to compare against.
pub(super) const UNMERGED: &str = "no merge of a pull request of this repository it links was \
                                   found on the trunk (not merged, origin not matched, no trunk, \
                                   or git failed), and it records no date — raised normally";

#[cfg(test)]
mod tests;
