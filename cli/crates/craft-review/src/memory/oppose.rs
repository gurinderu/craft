//! A passed record the memory opposes, as `blockedPassed` in `lib/memory-recall.mjs` judges it
//! (realm @nick/craft, nodes #224, #229): a record the store withdrew or superseded (the recall's
//! `inactive`), or an active recalled successor that supersedes or answers it, holds a passed copy
//! back — unless the passed record is dated later than every one of them; then it is applied over
//! them, and a successor's link no longer drops it.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value};

use super::recall::one_line;
use super::record::{self, has_control, linked_ids, plain_label, record_id, skill_record_id, text};

/// A record the store withdrew or superseded: every id it is known by, its status and date.
#[derive(Debug, Clone, Default)]
pub(super) struct Inactive {
    pub ids: Vec<String>,
    pub status: String,
    pub date: String,
}

/// The recall's `inactive` list read (`inactiveRecords`); an entry without any id is dropped.
pub(super) fn inactive(list: Option<&Value>) -> Vec<Inactive> {
    let empty = Map::new();
    list.and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|x| {
            let o = x.as_object().unwrap_or(&empty);
            let mut ids: Vec<String> = Vec::new();
            for id in [
                text(o.get("id")),
                text(o.get("storeId")),
                skill_record_id(o),
            ] {
                if !id.is_empty() && !ids.contains(&id) {
                    ids.push(id);
                }
            }
            let status = Some(one_line(o.get("status"))).filter(|s| !s.is_empty());
            let status = status.unwrap_or_else(|| "inactive".into());
            (!ids.is_empty()).then(|| Inactive {
                ids,
                status,
                date: one_line(o.get("date")),
            })
        })
        .collect()
}

/// An active recalled record whose `supersedes:`/`answers:` links name others.
#[derive(Debug, Clone)]
struct Successor {
    id: String,
    date: String,
    names: Vec<String>,
}

/// The successors among the recalled records that read (`successorRecords`).
fn successors(recalled: &[Value]) -> Vec<Successor> {
    recalled
        .iter()
        .filter(|x| record::read(x, &plain_label(0)).is_ok())
        .filter_map(|x| {
            let o = x.as_object()?;
            let links = o
                .get("links")
                .and_then(Value::as_array)
                .map_or(&[][..], Vec::as_slice);
            let names = linked_ids(links, &["supersedes", "answers"]);
            let date = Some(text(o.get("date")))
                .filter(|d| !d.is_empty())
                .unwrap_or_else(|| text(o.get("when")));
            (!names.is_empty()).then(|| Successor {
                id: record_id(o),
                date,
                names,
            })
        })
        .collect()
}

/// Every id a passed record is known by: its own, its derived one, its `store:` links.
fn passed_aliases(x: &Value) -> Vec<String> {
    let Some(o) = x.as_object() else {
        return Vec::new();
    };
    let links = o
        .get("links")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    [record_id(o), skill_record_id(o)]
        .into_iter()
        .filter(|s| !s.is_empty())
        .chain(linked_ids(links, &["store"]))
        .collect()
}

/// What the passed records the memory opposes come to.
#[derive(Debug, Clone, Default)]
pub(super) struct Blocked {
    /// The passed records held back, by index.
    pub at: BTreeSet<usize>,
    pub refused: Vec<String>,
    pub overrides: Vec<String>,
    /// The ids a successor's link no longer drops.
    pub freed: BTreeSet<String>,
    /// Each overriding passed record's index, and the successors it overrides.
    pub over: BTreeMap<usize, Vec<String>>,
}

/// The passed records at `only` an inactive record or an active successor opposes, each judged
/// (`blockedPassed`).
pub(super) fn blocked(
    passed: &[Value],
    gone: &[Inactive],
    only: &[usize],
    recalled: &[Value],
) -> Blocked {
    let succ = successors(recalled);
    let mut out = Blocked::default();
    for &i in only {
        let Some(x) = passed.get(i) else { continue };
        let ids = passed_aliases(x);
        let hits: Vec<&Inactive> = gone
            .iter()
            .filter(|e| e.ids.iter().any(|id| ids.contains(id)))
            .collect();
        let over: Vec<&Successor> = succ
            .iter()
            .filter(|s| s.names.iter().any(|id| ids.contains(id)))
            .collect();
        if hits.is_empty() && over.is_empty() {
            continue;
        }
        let tail = ids
            .first()
            .filter(|id| !has_control(id))
            .map(|id| format!(" ({id})"))
            .unwrap_or_default();
        let label = format!("passed decision #{i}{tail}");
        match opposed(x, &hits, &over) {
            Err(why) => {
                out.at.insert(i);
                out.refused.push(format!("{label} not applied: {why}"));
            }
            Ok(what) => {
                out.overrides
                    .push(format!("{label} applied over {what}: newer"));
                if !over.is_empty() {
                    out.freed.extend(ids);
                    out.over
                        .insert(i, over.iter().map(|s| s.id.clone()).collect());
                }
            }
        }
    }
    out
}

/// One passed record against the records opposing it: why it is held back, or what it is applied
/// over (`opposedVerdict`).
fn opposed(x: &Value, hits: &[&Inactive], over: &[&Successor]) -> Result<String, String> {
    let date = Some(text(x.get("when")))
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| text(x.get("date")));
    if let Some((s, why)) = over
        .iter()
        .map(|s| (s, not_later_why(&date, "active", &s.date)))
        .find(|(_, w)| !w.is_empty())
    {
        let at = if s.date.is_empty() {
            "undated"
        } else {
            &s.date
        };
        return Err(format!("held by {} (active, {at}) ({why})", s.id));
    }
    if let Some((e, why)) = hits
        .iter()
        .map(|e| (e, not_later_why(&date, &e.status, &e.date)))
        .find(|(_, w)| !w.is_empty())
    {
        return Err(format!("{} in memory ({why})", e.status));
    }
    let latest = hits.iter().copied().reduce(|m, e| {
        if not_later_why(&e.date, &m.status, &m.date).is_empty() {
            e
        } else {
            m
        }
    });
    let parts: Vec<String> = latest
        .map(|e| format!("a {} record of {}", e.status, e.date))
        .into_iter()
        .chain(
            over.iter()
                .map(|s| format!("{} (active, {})", s.id, s.date)),
        )
        .collect();
    Ok(parts.join(" and "))
}

/// A recalled record without its `supersedes:`/`answers:` links to any of `freed`.
pub(super) fn without_links_to(x: &Value, freed: &BTreeSet<String>) -> Value {
    let mut x = x.clone();
    if let Some(links) = x.get_mut("links").and_then(Value::as_array_mut) {
        links.retain(|l| {
            linked_ids(std::slice::from_ref(l), &["supersedes", "answers"])
                .iter()
                .all(|id| !freed.contains(id))
        });
    }
    x
}

/// A passed record with `overrides` naming the successors it overrides, so it is tried first.
pub(super) fn with_overrides(x: &Value, ids: Option<&Vec<String>>) -> Value {
    let mut x = x.clone();
    if let (Some(ids), Some(o)) = (ids.filter(|i| !i.is_empty()), x.as_object_mut()) {
        o.insert("overrides".into(), Value::from(ids.clone()));
    }
    x
}

/// Why passed date `p` does not override a record of `status` dated `date`; '' when it is later.
/// Two timestamps compare to the instant; otherwise by the UTC day (`notLaterWhy`).
fn not_later_why(p: &str, status: &str, date: &str) -> String {
    let Some(a) = moment(p) else {
        return "the passed record carries no ISO date to set against it".into();
    };
    let Some(b) = moment(date) else {
        return format!("the {status} record carries no ISO date to compare");
    };
    let same_day_later = a.0 == b.0 && matches!((a.1, b.1), (Some(x), Some(y)) if x > y);
    if a.0 > b.0 || same_day_later {
        String::new()
    } else {
        format!("the passed record's date {p} is not later than the {status} record's {date}")
    }
}

/// The days of month `m` of year `y`.
fn month_days(y: i64, m: i64) -> i64 {
    match m {
        2 if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// The day `by` (-1, 0 or 1) days from y-m-d, as YYYY-MM-DD.
fn shifted_day(y: i64, m: i64, d: i64, by: i64) -> String {
    let (mut y, mut m, mut d) = (y, m, d + by);
    if d < 1 {
        (y, m) = if m == 1 { (y - 1, 12) } else { (y, m - 1) };
        d = month_days(y, m);
    }
    if d > month_days(y, m) {
        (y, m, d) = if m == 12 {
            (y + 1, 1, 1)
        } else {
            (y, m + 1, 1)
        };
    }
    format!("{y:04}-{m:02}-{d:02}")
}

/// Digits at `s[a..b]` as a number.
fn num(s: &str, a: usize, b: usize) -> Option<i64> {
    let part = s.get(a..b)?;
    part.bytes()
        .all(|c| c.is_ascii_digit())
        .then(|| part.parse().ok())
        .flatten()
}

/// A zone's offset in minutes east of UTC; `None` when malformed or out of range.
fn zone_minutes(z: &str) -> Option<i64> {
    if z.is_empty() || z == "Z" {
        return Some(0);
    }
    let sign = match z.as_bytes().first() {
        Some(b'+') => 1,
        Some(b'-') => -1,
        _ => return None,
    };
    let (h, m) = (num(z, 1, 3)?, num(z, 4, 6)?);
    (z.len() == 6 && z.get(3..4) == Some(":") && h < 24 && m < 60).then_some(sign * (h * 60 + m))
}

/// A time of day after `T` in UTC seconds from its own day's midnight; `None` when malformed.
fn utc_seconds(t: &str) -> Option<f64> {
    let (h, min) = (num(t, 0, 2)?, num(t, 3, 5)?);
    if t.get(2..3) != Some(":") {
        return None;
    }
    let rest = t.get(5..)?;
    let zone_at = rest.find(['Z', '+', '-']).unwrap_or(rest.len());
    let (secs, zone) = rest.split_at(zone_at);
    let sec = match secs.strip_prefix(':') {
        None if secs.is_empty() => 0.0,
        Some(s)
            if s.len() >= 2
                && num(s, 0, 2).is_some()
                && (s.len() == 2
                    || s.get(2..3) == Some(".")
                        && s.len() > 3
                        && s.bytes().skip(3).all(|c| c.is_ascii_digit())) =>
        {
            s.parse().ok()?
        }
        _ => return None,
    };
    let off = zone_minutes(zone)?;
    let ok = h <= 23 && min <= 59 && sec < 60.0;
    #[expect(
        clippy::cast_precision_loss,
        reason = "minutes of a day fit an f64 exactly"
    )]
    let clock = ((h * 60 + min - off) * 60) as f64 + sec;
    ok.then_some(clock)
}

/// An ISO date read by hand (`isoMoment`): its UTC day and, for a timestamp, its seconds into
/// that day; `None` when it is no ISO date or names a day or time the calendar lacks.
fn moment(v: &str) -> Option<(String, Option<f64>)> {
    let (y, m, d) = (num(v, 0, 4)?, num(v, 5, 7)?, num(v, 8, 10)?);
    if v.get(4..5) != Some("-")
        || v.get(7..8) != Some("-")
        || !(1..=12).contains(&m)
        || d < 1
        || d > month_days(y, m)
    {
        return None;
    }
    let Some(t) = v.get(10..).filter(|t| !t.is_empty()) else {
        return Some((v.to_owned(), None));
    };
    let clock = utc_seconds(t.strip_prefix('T')?)?;
    let by: i64 = if clock < 0.0 {
        -1
    } else if clock >= 86400.0 {
        1
    } else {
        0
    };
    #[expect(
        clippy::cast_precision_loss,
        reason = "a day's seconds fit an f64 exactly"
    )]
    let at = clock - (by * 86400) as f64;
    Some((shifted_day(y, m, d, by), Some(at)))
}
