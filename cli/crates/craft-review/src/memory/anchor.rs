//! What a record's scope check compares against (`decisionDate` in
//! `integrations/shared/prior-decision-anchor.mjs`): its commit, else the calendar date its `when`
//! starts with — a record written where no commit may be named still sets a finding aside when
//! the code in its scope is unchanged since that day (realm @nick/craft, node #676).

use std::path::Path;

use super::PriorDecision;
use super::oppose::month_days;
use crate::git;

/// A record's anchor: the commit it names, or the day it was made.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Anchor<'a> {
    Commit(&'a str),
    Date(&'a str),
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
    pub(crate) fn since(self) -> String {
        match self {
            Anchor::Commit(c) => c.to_owned(),
            Anchor::Date(day) => format!("the decision date {day}"),
        }
    }

    /// Why the repository holds nothing to compare against — raised normally.
    pub(crate) fn missing(self) -> String {
        match self {
            Anchor::Commit(c) => format!("commit {c} not found in this repo — raised normally"),
            Anchor::Date(day) => {
                format!("no commit in this repo before the decision date {day} — raised normally")
            }
        }
    }

    /// The commit the scope is diffed against in `repo`: the anchor's own when the repository has
    /// it; for a date, the last commit reachable from `HEAD` before 00:00 UTC of that day, so an
    /// edit the same day counts as after the record. `None` when there is none.
    pub(crate) fn base(self, repo: &Path) -> Option<String> {
        match self {
            Anchor::Commit(c) => git::has_commit(repo, c).then(|| c.to_owned()),
            Anchor::Date(day) => git::last_before(repo, day),
        }
    }
}

/// The `YYYY-MM-DD` date `when` starts with, a real day of the calendar not run on by another
/// digit; `None` otherwise.
fn calendar_date(when: &str) -> Option<&str> {
    let day = when.get(..10)?;
    if when.as_bytes().get(10).is_some_and(u8::is_ascii_digit) {
        return None;
    }
    let num = |s: &str, len: usize| {
        (s.len() == len && s.bytes().all(|b| b.is_ascii_digit()))
            .then(|| s.parse::<i64>().ok())
            .flatten()
    };
    let (y, m, d) = (
        num(day.get(..4)?, 4)?,
        num(day.get(5..7)?, 2)?,
        num(day.get(8..)?, 2)?,
    );
    let dashed = day.as_bytes().get(4) == Some(&b'-') && day.as_bytes().get(7) == Some(&b'-');
    let real = (1..=12).contains(&m) && (1..=month_days(y, m)).contains(&d);
    (dashed && real).then_some(day)
}

#[cfg(test)]
mod tests;
