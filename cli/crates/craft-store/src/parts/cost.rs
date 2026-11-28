//! The cost a record of a run filed in parts is priced by, as `foldStoppedParts` in
//! `integrations/shared/run-parts.mjs` prices it (realm @nick/craft, node #658): the part standing
//! for the run — the first of its newest finished records, else the first of its newest — carries
//! every other stopped part's share summed once ([`crate::cost::fold`]); any other part its own.

use super::{Parts, part_key};
use crate::cost::fold::{self, Part};
use crate::js::{Js, JsString, Obj};

/// One part of a run as [`Parts::note`] saw it: the record's id (its file name, or its place
/// among the records read), time, stop and cost.
#[derive(Debug)]
pub(super) struct Noted {
    pub(super) id: String,
    pub(super) ts: JsString,
    pub(super) stopped: bool,
    pub(super) cost: Option<Js>,
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
    /// The cost to price `r`, noted as `id`, by ([`Self::cost_for`]).
    #[must_use]
    pub fn cost_of(&self, id: &str, r: &Obj) -> Option<Js> {
        self.cost_for(part_key(r).as_deref(), id, r.get("cost").cloned())
    }

    /// The cost to price the record noted as `id` of run `key` by: standing for its run, it
    /// carries every other stopped part's share summed once, else its own cost `own`.
    #[must_use]
    pub fn cost_for(&self, key: Option<&str>, id: &str, own: Option<Js>) -> Option<Js> {
        let Some(parts) = key.and_then(|k| self.costs.get(k)) else {
            return own;
        };
        let Some(at) = standing(parts).filter(|s| parts.get(*s).is_some_and(|p| p.id == id)) else {
            return own;
        };
        let folding = parts
            .iter()
            .enumerate()
            .filter(|(i, p)| p.stopped && *i != at);
        let ts = parts.get(at).map(|p| p.ts.clone()).unwrap_or_default();
        let all: Vec<Part> = std::iter::once((ts, own.clone()))
            .chain(folding.map(|(_, p)| (p.ts.clone(), p.cost.clone())))
            .collect();
        if all.len() == 1 {
            own
        } else {
            fold::summed(&all)
        }
    }
}
