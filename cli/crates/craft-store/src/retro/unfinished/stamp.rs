//! A run record's time stamp read as a time, as `storeTsMs` read it.

use crate::js::JsString;

/// The time a store stamp (`YYYY-MM-DDTHH-MM-SSZ`) names, `None` for a stamp or date that is not one.
#[must_use]
pub fn store_ts_ms(ts: &JsString) -> Option<f64> {
    let text = ts.as_str()?;
    let bytes = text.as_bytes();
    let shape = bytes.len() == 20
        && bytes.iter().enumerate().all(|(i, c)| match i {
            4 | 7 | 13 | 16 => *c == b'-',
            10 => *c == b'T',
            19 => *c == b'Z',
            _ => c.is_ascii_digit(),
        });
    if !shape {
        return None;
    }
    let n = |from: usize, to: usize| text.get(from..to).and_then(|s| s.parse::<i64>().ok());
    let (year, month, day) = (n(0, 4)?, n(5, 7)?, n(8, 10)?);
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let month_days = usize::try_from(month - 1).ok().and_then(|i| days.get(i))?;
    // The minutes and seconds `parse_ms` bounds; it reads 24:00 as the day's end, which a stamp never is.
    if day < 1 || day > *month_days || n(11, 13)? > 23 {
        return None;
    }
    crate::cost::date::parse_ms(&format!(
        "{}T{}:{}:{}Z",
        text.get(..10)?,
        text.get(11..13)?,
        text.get(14..16)?,
        text.get(17..19)?
    ))
}
