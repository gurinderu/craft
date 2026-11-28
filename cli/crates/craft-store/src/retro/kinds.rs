//! The retro's runs by kind — the workflow, and a review's depth and lens scope beside it — with
//! the time and agents their records carry, which every host records where cost is Claude Code's
//! alone (realm @nick/craft, node #658).

use std::collections::BTreeMap;

use crate::js::{Js, Obj, Utf16Error};
use crate::tally::round2;

/// One kind of run: how many, and what the ones that recorded it took.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Kind {
    pub runs: u64,
    /// The runs whose record carries its wall-clock minutes.
    pub timed: u64,
    pub minutes: f64,
    /// The runs whose record carries its agent count.
    pub counted: u64,
    pub agents: f64,
}

#[expect(clippy::cast_precision_loss, reason = "a run count is far below 2^52")]
fn per(sum: f64, n: u64) -> Option<f64> {
    (n > 0).then(|| round2(sum / n as f64))
}

impl Kind {
    /// The minutes of a run that recorded them, to two places.
    #[must_use]
    pub fn minutes_per_run(&self) -> Option<f64> {
        per(self.minutes, self.timed)
    }

    /// The agents of a run that recorded them, to two places.
    #[must_use]
    pub fn agents_per_run(&self) -> Option<f64> {
        per(self.agents, self.counted)
    }
}

/// The kind of `r`, a run of the workflow named `name`: the name, then its depth and lens scope
/// where the record names them (`review (cli) · light · delta`).
fn key(name: &str, r: &Obj) -> Result<String, Utf16Error> {
    let mut key = name.to_owned();
    for k in ["depth", "lensScope"] {
        if let Some(v) = r.get(k).filter(|v| v.truthy()) {
            key.push_str(" · ");
            key.push_str(&v.to_js_string()?);
        }
    }
    Ok(key)
}

/// Adds `r`, a finished run of the workflow named `name`, to its kind.
/// # Errors
/// When the record's depth or lens scope cannot be represented as Unicode.
pub fn add(r: &Obj, name: &str, kinds: &mut BTreeMap<String, Kind>) -> Result<(), Utf16Error> {
    let kind = kinds.entry(key(name, r)?).or_default();
    kind.runs += 1;
    let stats = r.get("runtimeStats").and_then(Js::as_obj);
    let count = |k: &str| {
        stats
            .and_then(|s| s.get(k))
            .and_then(Js::as_num)
            .filter(|n| n.is_finite() && *n >= 0.0)
    };
    if let Some(m) = count("wallClockMinutes") {
        kind.timed += 1;
        kind.minutes += m;
    }
    if let Some(a) = count("agents") {
        kind.counted += 1;
        kind.agents += a;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
