//! The driver's clock replayed over the steps a run segment kept, as `replay` in
//! `lib/cli-review-clock.mjs` reads them: the phase the last step ended, with its minutes and the
//! task agents dispatched in it, and the run's `runtimeStats` so far.

use crate::js::{Js, Obj};

/// A phase that ended.
#[derive(Debug, Clone, PartialEq)]
pub struct Ended {
    pub phase: String,
    /// `None` when no stamped step fell in it.
    pub minutes: Option<f64>,
    pub agents: f64,
}

/// `Math.round`: halves upward.
fn js_round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

/// Milliseconds as minutes to one place.
fn minutes(ms: f64) -> f64 {
    js_round(ms / 6000.0) / 10.0
}

/// A non-negative finite number of milliseconds.
fn millis(v: Option<&Js>) -> Option<f64> {
    v.and_then(Js::as_num)
        .filter(|n| n.is_finite() && *n >= 0.0)
}

#[derive(Default)]
struct Clock {
    agents: f64,
    first: Option<f64>,
    last: Option<f64>,
    current: String,
    agents_at_phase: f64,
    spent: Obj,
}

impl Clock {
    fn add(&mut self, name: &str, ms: f64) {
        let had = self.spent.get(name).and_then(Js::as_num).unwrap_or(0.0);
        self.spent.set(name, Js::Num(had + ms));
    }

    fn stamp(&mut self, step: &Obj) {
        let Some(at) = millis(step.get("at")) else {
            return;
        };
        let took = millis(step.get("took")).unwrap_or(0.0);
        if self.first.is_none() {
            self.first = Some(at - took);
            self.add("start", took);
        } else if let (Some(last), false) = (self.last, self.current.is_empty()) {
            let phase = self.current.clone();
            self.add(&phase, (at - last).max(0.0));
        }
        self.last = Some(at);
    }

    fn observe(&mut self, step: &Obj) -> Option<Ended> {
        self.stamp(step);
        let next = if step.get("done").is_some_and(Js::truthy) {
            String::new()
        } else {
            match step.get("phase") {
                None | Some(Js::Null) => String::new(),
                Some(p) => p.to_js_string(),
            }
        };
        if next == self.current {
            return None;
        }
        let ended = (!self.current.is_empty()).then(|| Ended {
            phase: self.current.clone(),
            minutes: self
                .spent
                .get(&self.current)
                .and_then(Js::as_num)
                .map(minutes),
            agents: self.agents - self.agents_at_phase,
        });
        self.current = next;
        self.agents_at_phase = self.agents;
        ended
    }

    fn stats(&self) -> Obj {
        let o = Obj::new()
            .with("agents", Js::Num(self.agents))
            .with("agentsOf", Js::str("tasks"));
        let (Some(first), Some(last)) = (self.first, self.last) else {
            return o;
        };
        let mut phases = Obj::new();
        for (k, ms) in self.spent.iter() {
            phases.set(k.clone(), Js::Num(minutes(ms.as_num().unwrap_or(0.0))));
        }
        o.with("wallClockMinutes", Js::Num(minutes(last - first)))
            .with("phaseMinutes", Js::Obj(phases))
    }
}

/// `Math.max(a, b)`, `NaN` when either is.
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

/// The clock over every step: the phase the last one ended, and the stats.
#[must_use]
pub fn replay(steps: &[Js]) -> (Option<Ended>, Obj) {
    let mut clock = Clock::default();
    let mut ended = None;
    let none = Obj::new();
    for step in steps {
        let step = step.as_obj().unwrap_or(&none);
        let n = step.get("agents").and_then(Js::as_num).unwrap_or(f64::NAN);
        clock.agents = js_max(clock.agents, n);
        ended = clock.observe(step);
    }
    (ended, clock.stats())
}
