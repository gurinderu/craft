//! Whether the code graph's index is fresh enough for a review: not older than the review's base
//! commit (realm @nick/craft, node #529).

use std::path::Path;

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

/// The committer time of `commit` in seconds since the epoch.
pub(super) fn commit_unix(top: &Path, commit: &str) -> Option<i64> {
    let out = crate::git::git(top, &["show", "-s", "--format=%ct", commit, "--"]).ok()?;
    out.trim().parse().ok()
}

/// Why an index made at `indexed_at` cannot serve a review whose base is `base` at `top`; `None`
/// when it is fresh.
pub(super) fn stale(top: &Path, base: &str, project: &str, indexed_at: &str) -> Option<String> {
    let Some(at) = iso_unix(indexed_at) else {
        return Some(format!(
            "the index of {project} names no time it was made ({indexed_at:?})"
        ));
    };
    let Some(base_at) = commit_unix(top, base) else {
        return Some(format!("the base {base} has no commit time"));
    };
    (at < base_at).then(|| {
        format!(
            "the index of {project} (made {indexed_at}) is older than the base commit; craft \
             never reindexes — refresh it with {}",
            super::cbm::refresh_hint(&top.display().to_string())
        )
    })
}

#[cfg(test)]
mod tests {
    use super::iso_unix;

    #[test]
    fn an_iso_time_reads_as_its_epoch_seconds() {
        assert_eq!(iso_unix("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(iso_unix("2026-10-25T15:27:09Z"), Some(1_792_942_029));
        assert_eq!(iso_unix("2000-02-29T00:00:01Z"), Some(951_782_401));
        assert_eq!(iso_unix("yesterday"), None);
    }
}
