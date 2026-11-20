//! The store's clock, in milliseconds since the epoch as JavaScript's `Date` counts them, and the two
//! spellings it writes: `Date.toISOString()` and `stamp` (`lib/craft-log-run.mjs`), the ISO time to
//! the second with `-` for `:`, which names files and sorts as it reads.

use std::time::{SystemTime, UNIX_EPOCH};

/// Now, in milliseconds.
#[must_use]
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// The civil date and time of `ms`: year, month, day, hour, minute, second, millisecond.
fn civil(ms: i64) -> (i64, i64, i64, i64, i64, i64, i64) {
    let (days, rest) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
    // Howard Hinnant's days-from-civil, inverted.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    (
        y,
        m,
        d,
        rest / 3_600_000,
        rest / 60_000 % 60,
        rest / 1000 % 60,
        rest % 1000,
    )
}

/// `new Date(ms).toISOString()`, for the years a store holds (0 to 9999).
#[must_use]
pub fn iso(ms: i64) -> String {
    let (y, mo, d, h, mi, s, milli) = civil(ms);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{milli:03}Z")
}

/// `stamp(new Date(ms))`.
#[must_use]
pub fn stamp(ms: i64) -> String {
    let (y, mo, d, h, mi, s, _) = civil(ms);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}-{mi:02}-{s:02}Z")
}

/// The time a stamp names, `None` when it names none: `stampMs`, which reads `:` or `-` between the
/// parts and fractional seconds.
#[must_use]
pub fn stamp_ms(ts: &str) -> Option<i64> {
    let re =
        regex::Regex::new(r"^(\d{4})-(\d\d)-(\d\d)T(\d\d)[:-](\d\d)[:-](\d\d)(?:\.\d+)?Z$").ok()?;
    let c = re.captures(ts)?;
    let n = |i: usize| c.get(i).and_then(|m| m.as_str().parse::<i64>().ok());
    let (year, month, day) = (n(1)?, n(2)?, n(3)?);
    let (hour, minute, second) = (n(4)?, n(5)?, n(6)?);
    let valid = (1..=12).contains(&month) && (1..=31).contains(&day);
    if !valid || hour > 24 || minute > 59 || second > 59 {
        return None;
    }
    let seconds = (hour * 60 + minute) * 60 + second;
    Some(days_from_civil(year, month, day) * 86_400_000 + seconds * 1000)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times_are_spelled_as_javascript_spells_them() {
        let ms = 1_793_548_800_123; // 2026-11-01T16:00:00.123Z
        assert_eq!(iso(ms), "2026-11-01T16:00:00.123Z");
        assert_eq!(stamp(ms), "2026-11-01T16-00-00Z");
        assert_eq!(iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(stamp(951_782_400_000), "2000-02-29T00-00-00Z");
    }

    #[test]
    fn a_stamp_reads_back_as_its_time() {
        assert_eq!(stamp_ms("2026-11-01T16-00-00Z"), Some(1_793_548_800_000));
        assert_eq!(stamp_ms("2026-11-01T16:00:00.5Z"), Some(1_793_548_800_000));
        assert_eq!(stamp_ms("nope"), None);
    }
}
