//! The runs that did not finish, listed apart from every sum (realm @nick/craft, nodes #61, #313,
//! #401), as the retired `partial-twins.mjs` chose them: a record rebuilt while its run was still alive is
//! hidden once that run files its complete record — one review of the same project's branch at
//! the same head, filed later, that folded every checkpoint of the rebuilt one, or, for one rebuilt
//! from a journal, whose run had started before it was rebuilt. Which slice a record is in is
//! [`slice`]; a complete record is judged against every partial whatever the slice.

use std::collections::BTreeSet;

use crate::js::{Js, JsString, Obj};

pub mod slice;
mod stamp;

pub use stamp::store_ts_ms;

/// A head shorter than this is no identity.
const MIN_HEAD: usize = 7;

/// A complete review record as a partial's finished form is judged.
#[derive(Debug, Clone, PartialEq)]
struct Complete {
    cli: bool,
    project: Option<Js>,
    branch: Option<Js>,
    head: JsString,
    ts: Option<f64>,
    phases: BTreeSet<String>,
    started: Option<f64>,
    /// Whether the record is inside the retro's slice.
    inside: Option<bool>,
}

/// What the retro lists of the runs that did not finish.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Unfinished {
    complete: Vec<Complete>,
    partials: Vec<(Obj, Option<bool>)>,
}

fn phases(r: &Obj) -> &[Js] {
    r.get("phases").and_then(Js::as_arr).unwrap_or(&[])
}

/// A checkpoint's identity: its phase and the instant it was written.
fn checkpoint_id(p: &Js) -> String {
    let field = |k: &str| match p.as_obj().and_then(|o| o.get(k)) {
        None | Some(Js::Null) => String::new(),
        Some(v) => v.to_js_text().to_utf8_lossy(),
    };
    format!("{}@{}", field("phase"), field("at"))
}

fn head(r: &Obj) -> JsString {
    r.text_units("head")
}

fn same_head(a: &JsString, b: &JsString) -> bool {
    let (x, y): (Vec<u16>, Vec<u16>) = (a.units().collect(), b.units().collect());
    x.len().min(y.len()) >= MIN_HEAD && (x.starts_with(&y) || y.starts_with(&x))
}

impl Unfinished {
    /// Notes a complete record, `inside` whether the slice keeps it.
    pub fn complete(&mut self, r: &Obj, inside: Option<bool>) {
        if !super::depth::is_review(r) {
            return;
        }
        let started = phases(r)
            .iter()
            .filter_map(|p| p.as_obj()?.get("at").map(Js::to_js_text))
            .filter_map(|a| crate::cost::date::parse_ms(a.as_str()?))
            .reduce(f64::min);
        self.complete.push(Complete {
            cli: super::is_cli(r),
            project: r.get("project").cloned(),
            branch: r.get("branch").cloned(),
            head: head(r),
            ts: store_ts_ms(&r.text_units("ts")),
            phases: phases(r).iter().map(checkpoint_id).collect(),
            started,
            inside,
        });
    }

    /// Notes a record of a run that died, `inside` whether the slice keeps it.
    pub fn partial(&mut self, r: &Obj, inside: Option<bool>) {
        self.partials.push((r.clone(), inside));
    }

    /// The records to list, how many the slice could not attribute, and how many rebuilt ones a
    /// complete record of the slice shows finished.
    #[must_use]
    pub fn settle(self, whole: bool) -> (Vec<Obj>, u64, u64) {
        let (mut listed, mut unattributed, mut twins) = (Vec::new(), 0, 0);
        for (p, inside) in self.partials {
            if let Some(by) = self.complete.iter().find(|c| finished_as(&p, c)) {
                twins += u64::from(whole || by.inside == Some(true));
                continue;
            }
            match (whole, inside) {
                (true, _) | (false, Some(true)) => listed.push(p),
                (false, None) => unattributed += 1,
                (false, Some(false)) => {}
            }
        }
        (listed, unattributed, twins)
    }
}

/// Whether complete record `c` is the finished form of the run partial record `p` was rebuilt from.
fn finished_as(p: &Obj, c: &Complete) -> bool {
    let branch = p
        .get("branch")
        .filter(|b| matches!(b, Js::Str(s) if !s.is_empty()));
    let same_review = super::depth::is_review(p)
        && super::is_cli(p) == c.cli
        && p.get("project") == c.project.as_ref()
        && branch.is_some()
        && branch == c.branch.as_ref()
        && same_head(&head(p), &c.head);
    let p_ts = store_ts_ms(&p.text_units("ts"));
    let newer = p_ts.zip(c.ts).is_some_and(|(p, c)| c > p);
    if !same_review || !newer || c.phases.is_empty() {
        return false;
    }
    if phases(p).is_empty() {
        return p_ts.zip(c.started).is_some_and(|(p, s)| s < p);
    }
    let own: Vec<String> = phases(p)
        .iter()
        .filter(|x| {
            let o = x.as_obj();
            let absent = |k: &str| o.and_then(|o| o.get(k)).is_none_or(|v| *v == Js::Null);
            absent("ledgerShard") && absent("recordPart")
        })
        .map(checkpoint_id)
        .collect();
    !own.is_empty() && own.iter().all(|id| c.phases.contains(id))
}

#[cfg(test)]
mod tests;
