//! The hook log's timestamps: JS's `Date.prototype.toISOString` (`2026-10-30T12:00:00.000Z`) and
//! the subset of `Date.parse` the log's lines spell — a date, or a date and time with `Z` or an
//! offset.

const DAY_MS: i64 = 86_400_000;

/// Days since 1970-01-01 of a civil date (Howard Hinnant's `days_from_civil`).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The civil date of a day count since 1970-01-01.
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// `ms` since the epoch as JS's `toISOString` spells it.
pub fn format(ms: i64) -> String {
    let (days, rest) = (ms.div_euclid(DAY_MS), ms.rem_euclid(DAY_MS));
    let (year, month, day) = civil_from_days(days);
    let (hour, min, sec, milli) = (
        rest / 3_600_000,
        rest / 60_000 % 60,
        rest / 1000 % 60,
        rest % 1000,
    );
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{min:02}:{sec:02}.{milli:03}Z")
}

fn num(s: &str) -> Option<i64> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

/// The milliseconds of a time `HH:MM[:SS[.fff]]`.
fn time_ms(t: &str) -> Option<i64> {
    let mut parts = t.splitn(3, ':');
    let h = num(parts.next()?).filter(|&h| h <= 24)?;
    let min = num(parts.next()?).filter(|&m| m < 60)?;
    let (s, frac) = match parts.next() {
        None => (0, 0),
        Some(sec) => {
            let (whole, frac) = sec.split_once('.').unwrap_or((sec, ""));
            let frac = if frac.is_empty() {
                0
            } else {
                num(&format!("{frac:0<3}").chars().take(3).collect::<String>())?
            };
            (num(whole).filter(|&s| s < 60)?, frac)
        }
    };
    Some(((h * 60 + min) * 60 + s) * 1000 + frac)
}

/// A timestamp's milliseconds since the epoch; `None` for what `Date.parse` would not read the
/// same way (a local time without a zone included).
pub fn parse(ts: &str) -> Option<i64> {
    let (date, time) = ts.split_once('T').map_or((ts, None), |(d, t)| (d, Some(t)));
    let mut ymd = date.splitn(3, '-');
    let (y, m, d) = (num(ymd.next()?)?, num(ymd.next()?)?, num(ymd.next()?)?);
    if date.len() != 10 || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let day = days_from_civil(y, m, d) * DAY_MS;
    let Some(time) = time else {
        return Some(day);
    };
    let (clock, offset) = if let Some(c) = time.strip_suffix('Z') {
        (c, 0)
    } else {
        let at = time.rfind(['+', '-'])?;
        let (c, zone) = (time.get(..at)?, time.get(at..)?);
        let sign = if zone.starts_with('-') { -1 } else { 1 };
        let (zh, zm) = zone.get(1..)?.split_once(':')?;
        (c, sign * (num(zh)? * 60 + num(zm)?) * 60_000)
    };
    Some(day + time_ms(clock)? - offset)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_timestamp_round_trips_as_js_spells_it() {
        let ms = 1_793_361_600_000;
        assert_eq!(format(ms), "2026-10-30T12:00:00.000Z");
        assert_eq!(parse("2026-10-30T12:00:00.000Z"), Some(ms));
        assert_eq!(parse("2026-10-30T12:00:00Z"), Some(ms));
        assert_eq!(parse("2026-10-30T14:00:00+02:00"), Some(ms));
        assert_eq!(parse("2026-10-30"), Some(ms - 12 * 3_600_000));
        assert_eq!(format(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(format(951_782_400_123), "2000-02-29T00:00:00.123Z");
        for bad in ["x", "", "2026-10-30T12:00:00", "2026-13-01T00:00Z"] {
            assert_eq!(parse(bad), None, "{bad}");
        }
    }
}
