//! The findings the review runs marked as going against an active memory record
//! (`memoryContradictions`; realm @nick/craft, nodes #281, #282), each chain — the CLI's review runs,
//! and every other engine's — apart: how many the doubt signs alone would have sent to the
//! reviewer, how many went to the PR as defects (an engine that posts nothing, `toPr: null`, apart),
//! and what became of each in the ledger of the newest later round of the same engine, project and
//! branch: fixed, still open, set aside; no later round; unknown without a fingerprint or a ledger.
//! A later round's ledger is read once every record is, by the id it was added under.

use crate::js::{Js, JsString, Obj};

mod fate;

use fate::fate;

/// One chain's sums.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Tally {
    pub runs: u64,
    pub count: f64,
    pub doubt_signs_alone: f64,
    pub to_pr: u64,
    pub no_posting: u64,
    pub fixed: u64,
    pub open: u64,
    pub set_aside: u64,
    pub no_later_round: u64,
    pub unknown: u64,
}

/// A record as a later round of another is judged.
#[derive(Debug, Clone, PartialEq)]
struct Seen {
    id: String,
    cli: bool,
    workflow: bool,
    review: bool,
    name: Option<Js>,
    nested: bool,
    project: Option<Js>,
    branch: Option<Js>,
    ts: JsString,
}

/// A run's contradicting findings, waiting for its later round.
#[derive(Debug, Clone, PartialEq)]
struct Pending {
    of: usize,
    count: f64,
    doubt: f64,
    /// Each finding's `toPr` and fingerprint.
    items: Vec<(Option<Js>, JsString)>,
}

/// The records seen and the runs waiting.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Contradictions {
    seen: Vec<Seen>,
    pending: Vec<Pending>,
}

/// A positive whole count, else 0.
fn whole(o: &Obj, k: &str) -> f64 {
    o.get(k)
        .and_then(Js::as_num)
        .filter(|n| n.is_finite() && n.fract() == 0.0 && *n > 0.0)
        .unwrap_or(0.0)
}

impl Seen {
    fn later_of(&self, of: &Self) -> bool {
        let same_engine = (self.review && of.review) || self.name == of.name;
        self.workflow
            && self.cli == of.cli
            && same_engine
            && !self.nested
            && of.branch.as_ref().is_some_and(Js::truthy)
            && self.project == of.project
            && self.branch == of.branch
            && self.ts > of.ts
    }
}

impl Contradictions {
    /// Notes one record added under `id`.
    pub fn add(&mut self, id: &str, r: &Obj) {
        let ts = r
            .get("ts")
            .map_or_else(|| "undefined".into(), Js::to_js_text);
        self.seen.push(Seen {
            id: id.to_owned(),
            cli: super::is_cli(r),
            workflow: r.text_units("kind") == "workflow",
            review: super::depth::is_review(r),
            name: r.get("name").cloned(),
            nested: r.get("nested").is_some_and(Js::truthy),
            project: r.get("project").cloned(),
            branch: r.get("branch").cloned(),
            ts,
        });
        let Some(m) = r.get("memoryContradictions").and_then(Js::as_obj) else {
            return;
        };
        let items = m
            .get("findings")
            .and_then(Js::as_arr)
            .unwrap_or(&[])
            .iter()
            .map(|f| {
                let f = f.as_obj();
                let fp = f.map(|f| f.text_units("fp")).unwrap_or_default();
                (f.and_then(|f| f.get("toPr")).cloned(), fp)
            })
            .collect();
        self.pending.push(Pending {
            of: self.seen.len() - 1,
            count: whole(m, "count"),
            doubt: whole(m, "doubtSignsAlone"),
            items,
        });
    }

    /// Each chain's tally, `[js, cli]`, `ledger` reading the `ledger` of the record added under an id.
    pub fn settle(&self, mut ledger: impl FnMut(&str) -> Option<Js>) -> [Tally; 2] {
        let mut out = [Tally::default(); 2];
        for p in &self.pending {
            let Some(of) = self.seen.get(p.of) else {
                continue;
            };
            let mut later: Option<&Seen> = None;
            for s in self.seen.iter().filter(|s| s.later_of(of)) {
                if later.is_none_or(|l| s.ts > l.ts) {
                    later = Some(s);
                }
            }
            let rows = later.map(|l| ledger(&l.id));
            let Some(t) = out.get_mut(usize::from(of.cli)) else {
                continue;
            };
            t.runs += 1;
            t.count += p.count;
            t.doubt_signs_alone += p.doubt;
            for (to_pr, fp) in &p.items {
                t.to_pr += u64::from(*to_pr == Some(Js::Bool(true)));
                t.no_posting += u64::from(*to_pr == Some(Js::Null));
                fate(t, fp, rows.as_ref());
            }
        }
        out
    }
}

#[cfg(test)]
mod tests;
