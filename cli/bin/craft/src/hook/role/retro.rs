//! The session start's offer of a retro (realm @nick/craft, node #658): read from the run store's
//! index without an agent or the network — this repository's review runs of the hook's own craft
//! version since its last `retro` record, a rust-audit's per-crate slices aside — and said at most
//! once a day per repository ([`super::retro_offered`]), so a retro, which spends tokens, is
//! offered and never run unasked. Silenced by `CRAFT_RETRO_HOOK=0`, which craft's own task
//! subprocesses carry. A release's full review offers none yet: its record does not say it is one.

use std::path::Path;

use craft_store::js::Obj;
use craft_store::read::{self, Skipped};

use super::{Ctx, iso, retro_offered};

pub const SWITCH: &str = "CRAFT_RETRO_HOOK";
const RUNS: usize = 20;
const UNCLEAN: usize = 3;
const DAYS: i64 = 14;
/// Fewer runs than this say too little for the time alone to offer a retro.
const DAYS_MIN_RUNS: usize = 5;
const DAY_MS: i64 = 86_400_000;

/// Why the offer is made.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Why {
    Runs,
    Unclean,
    Days(i64),
}

/// One review run of the version: its time and verdict, as the index spells them.
#[derive(Debug, Clone, Default)]
pub struct Row {
    pub ts: String,
    pub verdict: String,
}

/// The repository's review runs of the version since its last retro, oldest first.
#[derive(Debug, Default)]
pub struct Since {
    pub runs: Vec<Row>,
    pub last_retro: Option<String>,
}

fn unclean(verdict: &str) -> bool {
    let v = verdict.to_lowercase();
    v.is_empty()
        || ["block", "incomplete", "partial coverage"]
            .iter()
            .any(|w| v.contains(w))
}

/// The day number of a store stamp (`2026-11-27T23-11-13Z`).
fn day_of(ts: &str) -> Option<i64> {
    iso::parse(ts.get(..10)?).map(|ms| ms.div_euclid(DAY_MS))
}

/// Whether, and why, `since` calls for a retro on day `today`.
#[must_use]
pub fn decide(since: &Since, today: i64) -> Option<Why> {
    let n = since.runs.len();
    if n == 0 {
        return None;
    }
    if n >= RUNS {
        return Some(Why::Runs);
    }
    let last = since.runs.get(n.saturating_sub(UNCLEAN)..).unwrap_or(&[]);
    if last.len() == UNCLEAN && last.iter().all(|r| unclean(&r.verdict)) {
        return Some(Why::Unclean);
    }
    let anchor = since
        .last_retro
        .as_deref()
        .or(since.runs.first().map(|r| r.ts.as_str()));
    let days = today - anchor.and_then(day_of)?;
    (days >= DAYS && n >= DAYS_MIN_RUNS).then_some(Why::Days(days))
}

/// The review runs of `version` that the store at `store` files under `key`, since its last retro.
fn read(store: &Path, key: &str, version: &str) -> Since {
    let mut runs = Vec::new();
    let mut last_retro: Option<String> = None;
    let text = |r: &Obj, k: &str| r.text_units(k).to_utf8().unwrap_or_default();
    drop(read::index(store, &mut Skipped::default(), |_, r| {
        if r.text_units("project") != key {
            return;
        }
        let ts = text(&r, "ts");
        if r.text_units("kind") == craft_store::retro::DONE_KIND {
            last_retro = last_retro.take().max(Some(ts));
        } else if ["review", "cli-review"].contains(&text(&r, "name").as_str())
            && r.text_units("craftVersion") == version
            && !r.get("nested").is_some_and(craft_store::js::Js::truthy)
        {
            let verdict = text(&r, "verdict");
            runs.push(Row { ts, verdict });
        }
    }));
    runs.retain(|r| last_retro.as_ref().is_none_or(|l| r.ts > *l));
    runs.sort_by(|a, b| a.ts.cmp(&b.ts));
    Since { runs, last_retro }
}

fn text(n: usize, version: &str, since: &Since, why: Why) -> String {
    let from = if since.last_retro.is_some() {
        "the last retro"
    } else {
        "the first of them"
    };
    let why = match why {
        Why::Runs => String::new(),
        Why::Unclean => format!(", the last {UNCLEAN} without a clean verdict"),
        Why::Days(d) => format!(", {d} days ago"),
    };
    format!(
        "craft: {n} review run(s) of craft {version} in this repository since {from}{why}. The craft:retro skill reads where their minutes and tokens went and what to change in the review profile; it spends tokens, so offer it to the user in one line and run it only if they agree. To silence this offer, set {SWITCH}=0."
    )
}

/// The offer for the repository filed under `key`, at most once a day; `None` to stay silent.
pub fn offer(ctx: &Ctx, key: &str, version: &str) -> Option<String> {
    if ctx.var(SWITCH) == "0" || key.is_empty() {
        return None;
    }
    let home = ctx.home.as_deref()?;
    let store = home.join(".craft").join("runs");
    if !store.join("index.jsonl").is_file() {
        return None;
    }
    let today = ctx.now.div_euclid(DAY_MS);
    if retro_offered::already(home, key, today) {
        return None;
    }
    let since = read(&store, key, version);
    let why = decide(&since, today)?;
    retro_offered::mark(home, key, today, DAYS);
    Some(text(since.runs.len(), version, &since, why))
}

#[cfg(test)]
#[path = "retro_tests.rs"]
mod tests;
