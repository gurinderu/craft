//! The cost a record of a run filed in parts is priced by, as `foldStoppedParts` in
//! `integrations/shared/run-parts.mjs` prices it (realm @nick/craft, node #658): the part standing
//! for the run — the first of its newest finished records, else the first of its newest — carries
//! every other stopped part's share summed once ([`crate::cost::fold`]); any other part its own.

use super::{Parts, part_key, stopped};
use crate::cost::fold::{self, Part};
use crate::js::{Js, JsString, Obj};

/// One part of a run as [`Parts::note`] saw it, and whether a priced record has claimed it.
#[derive(Debug)]
pub(super) struct Noted {
    pub(super) ts: JsString,
    pub(super) stopped: bool,
    pub(super) cost: Option<Js>,
    pub(super) claimed: bool,
}

/// The part standing for a run: the first of its newest finished parts, else of its newest.
fn standing(parts: &[Noted]) -> Option<usize> {
    let newest = |finished: bool| {
        let mut best: Option<usize> = None;
        for (i, p) in parts
            .iter()
            .enumerate()
            .filter(|(_, p)| p.stopped != finished)
        {
            if best.and_then(|b| parts.get(b)).is_none_or(|b| p.ts > b.ts) {
                best = Some(i);
            }
        }
        best
    };
    newest(true).or_else(|| newest(false))
}

impl Parts {
    /// The cost to price `r` by ([`Self::cost_for`]).
    pub fn cost_of(&mut self, r: &Obj) -> Option<Js> {
        let key = part_key(r);
        self.cost_for(
            key.as_deref(),
            &r.text_units("ts"),
            stopped(r),
            r.get("cost").cloned(),
        )
    }

    /// The cost to price a record of run `key`, filed at `ts`, by: the first unclaimed part noted
    /// with its time and stop is the record; standing for its run, it carries every other stopped
    /// part's share summed once, else its own cost `own`.
    pub fn cost_for(
        &mut self,
        key: Option<&str>,
        ts: &JsString,
        was_stopped: bool,
        own: Option<Js>,
    ) -> Option<Js> {
        let Some(parts) = key.and_then(|k| self.costs.get_mut(k)) else {
            return own;
        };
        let me = parts
            .iter()
            .position(|p| !p.claimed && p.ts == *ts && p.stopped == was_stopped);
        if let Some(p) = me.and_then(|i| parts.get_mut(i)) {
            p.claimed = true;
        }
        let Some(at) = standing(parts).filter(|s| Some(*s) == me) else {
            return own;
        };
        let folding = parts
            .iter()
            .enumerate()
            .filter(|(i, p)| p.stopped && *i != at);
        let all: Vec<Part> = std::iter::once((ts.clone(), own.clone()))
            .chain(folding.map(|(_, p)| (p.ts.clone(), p.cost.clone())))
            .collect();
        if all.len() == 1 {
            own
        } else {
            fold::summed(&all)
        }
    }
}
