//! Whether the code graph's index can serve a review: it was made of a commit holding the
//! review's base (realm @nick/craft, node #529). The graph names no commit it indexed, only when
//! (`indexed_at`), so the commit is the one its root's HEAD was at then, read from that HEAD's
//! reflog — written by the same clock as the index, unlike a commit's own time.

use std::path::Path;

use super::cbm::{Index, refresh_hint};
use crate::git::GitError;

/// How many of the root's HEAD moves are read back.
const MOVES_MAX: &str = "5000";

/// Why an index cannot serve a review.
#[derive(Debug, thiserror::Error)]
pub enum Stale {
    #[error("the index of {project} names no time it was made ({at:?})")]
    NoTime { project: String, at: String },
    #[error(
        "the HEAD history of {root}, which the index of {project} is of, could not be read: {source}"
    )]
    History {
        project: String,
        root: String,
        #[source]
        source: GitError,
    },
    #[error(
        "the HEAD history of {root} reaches back to no time before the index of {project} was \
         made ({at}), so which commit it was made of is unknown; craft never reindexes — refresh \
         it with {refresh}"
    )]
    Unknown {
        project: String,
        root: String,
        at: String,
        refresh: String,
    },
    #[error(
        "the index of {project} (made {at}) is of {commit}, which does not hold the base {base}; \
         craft never reindexes — refresh it with {refresh}"
    )]
    Older {
        project: String,
        at: String,
        commit: String,
        base: String,
        refresh: String,
        /// git's answer to whether that commit holds the base: its exit, or why it could not tell.
        #[source]
        source: GitError,
    },
}

/// Seconds since the epoch of `YYYY-MM-DDTHH:MM:SS` (a trailing `Z` or fraction ignored), as
/// UTC; `None` when it is not that.
pub(super) fn iso_unix(s: &str) -> Option<i64> {
    let num = |a: usize, b: usize| s.get(a..b)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, se) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if s.get(4..5) != Some("-") || s.get(10..11) != Some("T") {
        return None;
    }
    // Days from the civil date (Howard Hinnant's algorithm).
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (mo + if mo > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + h * 3600 + mi * 60 + se)
}

/// The commit HEAD was at, at `at` (seconds), from `git log -g --format='%H %gd' --date=unix`:
/// the newest move made then or before. `None` when every move listed is later.
pub(super) fn head_at(moves: &str, at: i64) -> Option<String> {
    moves.lines().find_map(|l| {
        let (commit, selector) = l.split_once(' ')?;
        let when = selector.strip_prefix("HEAD@{")?.strip_suffix('}')?;
        (when.parse::<i64>().ok()? <= at).then(|| commit.to_owned())
    })
}

/// Why `index` (of the graph's `project`, its root not empty) cannot serve a review whose base
/// is `base`; `Ok` when the commit its root's HEAD was at when it was made holds the base.
///
/// # Errors
/// When it names no time, its root's HEAD history cannot be read or does not reach back to it,
/// or that commit does not hold the base.
pub(super) fn stale(base: &str, project: &str, index: &Index) -> Result<(), Box<Stale>> {
    let at = iso_unix(&index.at).ok_or_else(|| Stale::NoTime {
        project: project.to_owned(),
        at: index.at.clone(),
    })?;
    let root = Path::new(&index.root);
    let args = [
        "log",
        "-g",
        "-n",
        MOVES_MAX,
        "--format=%H %gd",
        "--date=unix",
        "HEAD",
        "--",
    ];
    let moves = crate::git::git(root, &args).map_err(|source| Stale::History {
        project: project.to_owned(),
        root: index.root.clone(),
        source,
    })?;
    let refresh = refresh_hint(&index.root);
    let Some(commit) = head_at(&moves, at) else {
        return Err(Box::new(Stale::Unknown {
            project: project.to_owned(),
            root: index.root.clone(),
            at: index.at.clone(),
            refresh,
        }));
    };
    let holds = crate::git::git(root, &["merge-base", "--is-ancestor", base, &commit]);
    holds.map(drop).map_err(|source| {
        Box::new(Stale::Older {
            project: project.to_owned(),
            at: index.at.clone(),
            commit: commit.chars().take(12).collect(),
            base: base.chars().take(12).collect(),
            refresh,
            source,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::{head_at, iso_unix};

    #[test]
    fn an_iso_time_reads_as_its_epoch_seconds() {
        assert_eq!(iso_unix("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(iso_unix("2026-10-25T15:27:09Z"), Some(1_792_942_029));
        assert_eq!(iso_unix("2000-02-29T00:00:01Z"), Some(951_782_401));
        assert_eq!(iso_unix("yesterday"), None);
    }

    #[test]
    fn head_at_a_time_is_the_newest_move_made_by_then() {
        let moves = "c3 HEAD@{300}\nc2 HEAD@{200}\nc1 HEAD@{100}\n";
        assert_eq!(head_at(moves, 250).as_deref(), Some("c2"));
        assert_eq!(head_at(moves, 300).as_deref(), Some("c3"));
        assert_eq!(head_at(moves, 999).as_deref(), Some("c3"));
        assert_eq!(head_at(moves, 99), None);
        assert_eq!(head_at("garbage\n", 999), None);
    }
}
