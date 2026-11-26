//! What a record's scope check compares against (`decisionDate` in
//! `integrations/shared/prior-decision-anchor.mjs`): its commit, else the UTC day its `when`
//! names — a record written where no commit may be named still sets a finding aside when the
//! code in its scope is unchanged since that day (realm @nick/craft, node #676).

use std::path::Path;

use super::PriorDecision;
use super::oppose::moment;
use crate::git;

/// A record's anchor: the commit it names, or the UTC day it was made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Anchor<'a> {
    Commit(&'a str),
    Date(String),
}

/// Why a record's anchor names no commit to diff its scope against, each as the scope-check line
/// of `scopeCheckScript` prints it after the record's id.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Unusable {
    /// The repository lacks the commit, or the trunk holds none before the date.
    Missing,
    /// The date is later than today in UTC.
    Future,
    /// No trunk: no `origin/HEAD`, `origin/main` or `origin/master` names a commit.
    NoTrunk,
    /// git failed listing the trunk's commits.
    Unreadable,
}

impl Unusable {
    /// The word the scope-check line prints for it.
    #[cfg(test)]
    pub(crate) fn from_word(word: &str) -> Option<Self> {
        match word {
            "missing" => Some(Self::Missing),
            "future" => Some(Self::Future),
            "no-trunk" => Some(Self::NoTrunk),
            "unreadable" => Some(Self::Unreadable),
            _ => None,
        }
    }
}

impl PriorDecision {
    /// What its scope is compared against; `None` when it names no commit and no calendar date.
    pub(crate) fn anchor(&self) -> Option<Anchor<'_>> {
        if !self.commit.is_empty() {
            return Some(Anchor::Commit(&self.commit));
        }
        calendar_date(&self.when).map(Anchor::Date)
    }
}

impl Anchor<'_> {
    /// What the scope is said to have changed since.
    pub(crate) fn since(&self) -> String {
        match self {
            Anchor::Commit(c) => (*c).to_owned(),
            Anchor::Date(day) => format!("the decision date {day}"),
        }
    }

    /// Why the repository holds nothing to compare against — raised normally.
    pub(crate) fn missing(&self) -> String {
        self.unusable(Unusable::Missing)
    }

    /// Why the anchor names no commit to compare against, for `why` — raised normally.
    pub(crate) fn unusable(&self, why: Unusable) -> String {
        let day = match self {
            Anchor::Commit(c) => {
                return format!("commit {c} not found in this repo — raised normally");
            }
            Anchor::Date(day) => day,
        };
        match why {
            Unusable::Missing => {
                format!("no commit in this repo before the decision date {day} — raised normally")
            }
            Unusable::Future => format!(
                "the decision date {day} is in the future, so no commit precedes it — raised normally"
            ),
            Unusable::NoTrunk => format!(
                "no trunk could be resolved (no origin/HEAD, origin/main or origin/master), so \
                 nothing anchors the decision date {day} — raised normally"
            ),
            Unusable::Unreadable => format!(
                "git could not list the trunk's commits before the decision date {day} — raised \
                 normally"
            ),
        }
    }

    /// The commit the scope is diffed against in `repo`, `today` being the UTC date: the anchor's
    /// own when the repository has it. For a date, the last commit before that day began anywhere
    /// (00:00 at +14:00) on the first-parent line of the trunk's tip, `trunk` resolving it when
    /// asked — not over `HEAD`'s history nor from where `HEAD` forks from the trunk, where a
    /// branch's backdated commit, or a side branch's commit dated before the day but merged after
    /// it, would be the base and hide a later change of the scope. Diffed against the working
    /// tree, the change's own edits of the scope and any trunk commit the checkout lacks thus count
    /// as after the record (realm @nick/craft, node #676). A date later than `today` anchors
    /// nothing.
    pub(crate) fn base<'t>(
        &self,
        repo: &Path,
        today: &str,
        trunk: impl FnOnce() -> Option<&'t str>,
    ) -> Result<String, Unusable> {
        let day = match self {
            Anchor::Commit(c) => {
                return git::has_commit(repo, c)
                    .then(|| (*c).to_owned())
                    .ok_or(Unusable::Missing);
            }
            Anchor::Date(day) => day,
        };
        if day.as_str() > today {
            return Err(Unusable::Future);
        }
        let tip = trunk().ok_or(Unusable::NoTrunk)?;
        git::last_before(repo, tip, day)
            .map_err(|_said_by_git| Unusable::Unreadable)?
            .ok_or(Unusable::Missing)
    }
}

/// Today's date in UTC, `YYYY-MM-DD`.
pub(crate) fn today() -> String {
    let now = craft_store::time::iso(craft_store::time::now_ms());
    now.get(..10).unwrap_or_default().to_owned()
}

/// The UTC day of the ISO date `when` is (a timestamp's zone applied, `isoMoment`), or of the
/// `YYYY-MM-DD` it starts with when words follow it; `None` when neither names a real day.
fn calendar_date(when: &str) -> Option<String> {
    if let Some((day, _)) = moment(when) {
        return Some(day);
    }
    let rest = when.get(10..)?;
    if rest.starts_with(|c: char| c.is_ascii_digit() || c == 'T') {
        return None;
    }
    moment(when.get(..10)?).map(|(day, _)| day)
}

#[cfg(test)]
mod tests;
