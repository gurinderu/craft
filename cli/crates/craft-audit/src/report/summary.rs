//! A finished pass as its report and record say it: what it read, its findings settled, which of
//! them no verifier judged and which are held apart.

use craft_review::settle::Tier;
use serde_json::Value;

/// A finished pass of an audit, as its report and record say it.
#[derive(Debug, Clone, PartialEq)]
pub struct Summary {
    pub verdict: String,
    /// The paths no answered lens job read, in order.
    pub unread: Vec<String>,
    /// Every lens job the scout's parts need, and how many of them answered.
    pub jobs: usize,
    pub answered: usize,
    /// Every finding settled, in pool order.
    pub settled: Vec<Value>,
    /// Where in `settled` the findings no verifier judged though one must ([`crate::pool::unjudged`]).
    pub unjudged: Vec<usize>,
    /// The lenses of each profile with files that the audit does not run.
    pub left: Vec<(String, Vec<String>)>,
}

impl Summary {
    /// How many findings are confirmed, suspected, refuted and unverified, in that order.
    #[must_use]
    pub fn tiers(&self) -> [usize; 4] {
        let mut n = [0; 4];
        for f in &self.settled {
            let at = match Tier::of(f) {
                Tier::Confirmed => 0,
                Tier::Suspected => 1,
                Tier::Refuted => 2,
                Tier::Unverified => 3,
            };
            if let Some(c) = n.get_mut(at) {
                *c += 1;
            }
        }
        n
    }

    /// Whether `settled[i]` is held apart: unverified at Low or Info, and never a verifier's to
    /// judge — one its harm capped there after its lens rated it Medium or above is unjudged.
    fn holds(&self, i: usize, f: &Value) -> bool {
        craft_review::report::unverified::held(f) && !self.unjudged.contains(&i)
    }

    /// The unverified findings at Low and Info, held apart.
    #[must_use]
    pub fn held(&self) -> Vec<&Value> {
        self.settled
            .iter()
            .enumerate()
            .filter(|(i, f)| self.holds(*i, f))
            .map(|(_, f)| f)
            .collect()
    }

    /// The findings the report lists, every one not held apart, in pool order.
    #[must_use]
    pub fn listed(&self) -> Vec<&Value> {
        self.settled
            .iter()
            .enumerate()
            .filter(|(i, f)| !self.holds(*i, f))
            .map(|(_, f)| f)
            .collect()
    }

    /// Whether the pass left something to resume: a file unread or a finding unjudged.
    #[must_use]
    pub fn incomplete(&self) -> bool {
        !self.unread.is_empty() || !self.unjudged.is_empty()
    }
}
