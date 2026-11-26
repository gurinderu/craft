//! A record's pull requests (`pullLinks` in `integrations/shared/prior-decision-record.mjs`): the
//! GitHub pull request URLs among its links, and the merge on the trunk of the first that names
//! this repository, which anchors a record that names no commit (realm @nick/craft, node #682).

use std::cell::OnceCell;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::super::record::text;
use super::{Base, Unusable};
use crate::git;

/// A pull request a record links: its repository, `owner/name` lower-cased, and its number.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pull {
    pub repo: String,
    pub number: u64,
}

/// The pull requests `links` name, in their order: each `https://github.com/<owner>/<name>/pull/<N>`,
/// whatever follows it after `/`, `#` or `?`, the host and the path case-insensitive.
pub(in crate::memory) fn pulls(links: &[Value]) -> Vec<Pull> {
    links.iter().filter_map(|l| pull(&text(Some(l)))).collect()
}

fn pull(link: &str) -> Option<Pull> {
    let head = "https://github.com/";
    let rest = link
        .get(..head.len())
        .filter(|h| h.eq_ignore_ascii_case(head))
        .and_then(|_| link.get(head.len()..))?;
    let mut parts = rest.splitn(4, '/');
    let (owner, name) = (parts.next()?, parts.next()?);
    let named = |s: &str| {
        !s.is_empty()
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    };
    let pull = parts.next().filter(|p| p.eq_ignore_ascii_case("pull"));
    if !(named(owner) && named(name)) || pull.is_none() {
        return None;
    }
    let tail = parts.next()?;
    let digits = tail.bytes().take_while(u8::is_ascii_digit).count();
    let rest = tail.get(digits..)?;
    let fits = (1..=9).contains(&digits) && !tail.starts_with('0');
    let ends = rest.is_empty() || rest.starts_with(['/', '#', '?']);
    if !(fits && ends) {
        return None;
    }
    Some(Pull {
        repo: format!("{owner}/{name}").to_ascii_lowercase(),
        number: tail.get(..digits)?.parse().ok()?,
    })
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
    /// [`Unusable::Unreadable`] when git fails listing the trunk before that day.
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
/// @nick/craft, node #682). A day naming no base — in the future, or the trunk holding no commit
/// before it — leaves the merge alone to compare against; git failing to list the trunk raises the
/// record, as it raises one anchored by its date alone.
fn with_date(mut base: Base, dated: Option<Result<String, Unusable>>) -> Result<Base, Unusable> {
    match dated {
        Some(Err(Unusable::Unreadable)) => Err(Unusable::Unreadable),
        Some(Ok(b)) => {
            base.dated = Some(b);
            Ok(base)
        }
        Some(Err(_)) | None => Ok(base),
    }
}

/// The `owner/name` after origin's GitHub prefix, `.git` after it or not; `None` for a URL of
/// another host or form.
fn named(url: &str) -> Option<&str> {
    let https = url.strip_prefix("https://").map(|r| {
        let host = r.find('/').map_or(r, |end| r.get(..end).unwrap_or(r));
        host.rfind('@').and_then(|at| r.get(at + 1..)).unwrap_or(r)
    });
    let rest = https
        .and_then(|r| r.strip_prefix("github.com/"))
        .or_else(|| url.strip_prefix("git@github.com:"))
        .or_else(|| url.strip_prefix("ssh://git@github.com/"))?;
    Some(rest.strip_suffix('/').unwrap_or(rest))
}

/// What a scope is said to have changed since when its base was the merge of pull request `n`.
pub(crate) fn since_merge(n: u64) -> String {
    format!("the merge of PR #{n}")
}

/// Where a scope is said to have changed when it changed on the trunk between the decision date
/// `day` and the merge of pull request `n`.
pub(crate) fn before_merge(day: &str, n: u64) -> String {
    format!("on the trunk between the decision date {day} and the merge of PR #{n}")
}

/// Why a record anchored by its pull requests alone names nothing to compare against.
pub(super) const UNMERGED: &str = "no merge of a pull request of this repository it links was \
                                   found on the trunk (not merged, origin not matched, no trunk, \
                                   or git failed), and it records no date — raised normally";

#[cfg(test)]
mod tests;
