//! `Date.parse` for the ISO 8601 forms a transcript's `timestamp` is written in: a date
//! (`2026-10-29`, UTC), or a date and time to the minute, second or fraction (any number of digits,
//! read to the millisecond) with `Z` or a `±HH:MM` offset. A time with no offset is read as UTC —
//! JavaScript reads it as local time; the harness always writes `Z`. Other spellings `Date.parse`
//! guesses at name no time here.

use std::sync::LazyLock;

use regex::Regex;

static ISO: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(
        r"^([0-9]{4})-([0-9]{2})-([0-9]{2})(?:T([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]+))?)?(Z|[+-][0-9]{2}:[0-9]{2})?)?$",
    )
    .ok()
});

/// The milliseconds since the epoch `text` names, `None` when it names none.
#[must_use]
pub fn parse_ms(text: &str) -> Option<f64> {
    let caps = ISO.as_ref()?.captures(text)?;
    let part = |i: usize| {
        caps.get(i)
            .map_or(Some(0), |m| m.as_str().parse::<i64>().ok())
    };
    let (year, month, day) = (part(1)?, part(2)?, part(3)?);
    let (hour, minute, second) = (part(4)?, part(5)?, part(6)?);
    // A day past its month's end rolls over, as V8 reads it (`2026-02-30` is March 2).
    let valid = (1..=12).contains(&month) && (1..=31).contains(&day);
    // 24:00 is the end of the day, as JavaScript reads it.
    let time_ok =
        (hour < 24 && minute < 60 && second < 60) || (hour == 24 && minute == 0 && second == 0);
    if !valid || !time_ok {
        return None;
    }
    let ms = caps.get(7).map_or(Some(0), |m| {
        let digits: String = m.as_str().chars().chain("00".chars()).take(3).collect();
        digits.parse::<i64>().ok()
    })?;
    let offset = match caps.get(8).map(|m| m.as_str()) {
        None | Some("Z") => 0,
        Some(o) => {
            let sign = if o.starts_with('-') { -1 } else { 1 };
            let oh: i64 = o.get(1..3)?.parse().ok()?;
            let om: i64 = o.get(4..6)?.parse().ok()?;
            if oh > 23 || om > 59 {
                return None;
            }
            sign * (oh * 60 + om)
        }
    };
    let minutes = days_from_civil(year, month, day) * 1440 + hour * 60 + minute - offset;
    #[expect(
        clippy::cast_precision_loss,
        reason = "a store's years are far inside a double's integers"
    )]
    Some(((minutes * 60 + second) * 1000 + ms) as f64)
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
    fn the_iso_spellings_read_as_javascript_reads_them() {
        assert_eq!(parse_ms("1970-01-01T00:00:00.000Z"), Some(0.0));
        assert_eq!(parse_ms("2026-10-29T10:01:00Z"), Some(1_793_268_060_000.0));
        assert_eq!(
            parse_ms("2026-10-29T12:01:00+02:00"),
            parse_ms("2026-10-29T10:01:00Z")
        );
        assert_eq!(
            parse_ms("2026-10-29T10:01:00.123456Z"),
            Some(1_793_268_060_123.0)
        );
        assert_eq!(
            parse_ms("2026-10-29T10:01:00.5Z"),
            Some(1_793_268_060_500.0)
        );
        assert_eq!(parse_ms("2026-10-29"), Some(1_793_232_000_000.0));
        assert_eq!(parse_ms("2026-10-29T10:01Z"), Some(1_793_268_060_000.0));
        assert_eq!(parse_ms("2026-02-30"), Some(1_772_409_600_000.0));
        assert_eq!(parse_ms("2026-10-29T24:00:00Z"), Some(1_793_318_400_000.0));
        for bad in [
            "",
            "undefined",
            "2026-13-01",
            "2026-02-32",
            "2026-10-29T25:00Z",
            "x2026-10-29",
        ] {
            assert_eq!(parse_ms(bad), None, "{bad}");
        }
    }
}
