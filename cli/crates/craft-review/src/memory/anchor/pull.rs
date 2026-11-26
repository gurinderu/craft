//! A record's pull requests (`pullLinks` in `integrations/shared/prior-decision-record.mjs`): the
//! GitHub pull request URLs among its links, and the merge on the trunk of the first that names
//! this repository, which anchors a record that names no commit (realm @nick/craft, node #682).

use std::cell::OnceCell;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::super::record::text;
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

    /// The first of `pulls` whose repository origin names: its URL, lower-cased, is
    /// `https://github.com/`, `git@github.com:` or `ssh://git@github.com/` followed by the
    /// repository, `.git` after it or not.
    fn ours<'a>(&self, pulls: &'a [Pull]) -> Option<&'a Pull> {
        let url = self.origin.get_or_init(|| git::origin_url(self.path));
        let url = url.as_deref()?;
        let rest = [
            "https://github.com/",
            "git@github.com:",
            "ssh://git@github.com/",
        ]
        .iter()
        .find_map(|p| url.strip_prefix(p))?;
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
}

#[cfg(test)]
mod tests;
