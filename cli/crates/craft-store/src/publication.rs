//! A finished run published on its PR after the fact (`craft review comment`), written into its
//! record as `applyPublication` in `lib/sorting-choice.mjs` writes it: the sorting, the findings
//! going against memory and what was posted replace the record's own, and each choice the reviewer
//! already recorded follows its finding — by file, line and title — to its number in the new
//! sorting; one whose finding is gone is dropped and named.

use crate::js::{Js, Obj};

fn sorting_of(r: &Obj) -> Option<&Obj> {
    r.get("sorting").and_then(Js::as_obj)
}

fn sorted_findings(sorting: Option<&Obj>) -> Vec<&Obj> {
    let list = sorting.and_then(|s| s.get("findings")).and_then(Js::as_arr);
    list.unwrap_or(&[]).iter().filter_map(Js::as_obj).collect()
}

/// `Number(v)` for what a stored finding's line can be.
fn js_number(v: Option<&Js>) -> f64 {
    match v {
        Some(Js::Null) => 0.0,
        Some(Js::Bool(b)) => f64::from(u8::from(*b)),
        Some(Js::Num(n)) => *n,
        Some(Js::Str(s)) => {
            let t = s.trim();
            if t.is_empty() {
                0.0
            } else {
                t.parse().unwrap_or(f64::NAN)
            }
        }
        None | Some(Js::Arr(_) | Js::Obj(_)) => f64::NAN,
    }
}

/// `String(v ?? '')`.
fn string_or_empty(v: Option<&Js>) -> String {
    match v {
        None | Some(Js::Null) => String::new(),
        Some(v) => v.to_js_string(),
    }
}

/// A value in a template literal: `undefined` for what is absent.
fn templated(v: Option<&Js>) -> String {
    v.map_or_else(|| "undefined".to_owned(), Js::to_js_string)
}

/// A doubtful finding's identity across two sortings: `JSON.stringify([file, line, title])`.
fn finding_key(f: &Obj) -> String {
    let line = js_number(f.get("line"));
    let line = if line.is_nan() || line == 0.0 {
        0.0
    } else {
        line
    };
    Js::Arr(vec![
        Js::str(string_or_empty(f.get("file"))),
        Js::Num(line),
        Js::str(string_or_empty(f.get("title"))),
    ])
    .compact()
}

fn dropped_choice(n: &str, f: Option<&Obj>, c: &Js) -> String {
    let what = f.map_or_else(
        || "no such finding".to_owned(),
        |f| {
            format!(
                "{} @ {}:{}",
                templated(f.get("title")),
                templated(f.get("file")),
                templated(f.get("line"))
            )
        },
    );
    let choice = string_or_empty(c.as_obj().and_then(|c| c.get("choice")));
    format!("{n} ({what}): {choice}")
}

/// The record's choices renumbered for `next`, `None` when none carries over, and those dropped.
fn carried_choices(record: &Obj, next: Option<&Obj>) -> (Option<Obj>, Vec<String>) {
    let Some(old) = sorting_of(record)
        .and_then(|s| s.get("choices"))
        .and_then(Js::as_obj)
    else {
        return (None, Vec::new());
    };
    let before = sorted_findings(sorting_of(record));
    let after = sorted_findings(next);
    let number = |f: &Obj| templated(f.get("n"));
    let mut choices = Obj::new();
    let mut dropped = Vec::new();
    for (n, c) in old.iter() {
        // A later finding with the same number replaces an earlier one, as a Map's `set` does.
        let f = before.iter().rev().find(|f| number(f) == *n).copied();
        let to = f.and_then(|f| {
            let key = finding_key(f);
            after
                .iter()
                .rev()
                .find(|a| finding_key(a) == key)
                .map(|a| number(a))
        });
        match to {
            Some(to) if !to.is_empty() => choices.set(to, c.clone()),
            _ => dropped.push(dropped_choice(n, f, c)),
        }
    }
    ((!choices.is_empty()).then_some(choices), dropped)
}

/// The record with the publication `kept` written in, and the choices dropped.
#[must_use]
pub fn apply(record: &Obj, kept: &Obj) -> (Obj, Vec<String>) {
    let next = kept.get("sorting").and_then(Js::as_obj);
    let (choices, dropped) = carried_choices(record, next);
    let sorting = match (next, choices) {
        (Some(n), Some(c)) => Js::Obj(n.clone().with("choices", Js::Obj(c))),
        (Some(n), None) => Js::Obj(n.clone()),
        (None, _) => Js::Null,
    };
    let field = |k: &str| match kept.get(k) {
        None | Some(Js::Null) => Js::Null,
        Some(v) => v.clone(),
    };
    let mut out = record.clone();
    out.set("sorting", sorting);
    out.set("memoryContradictions", field("memoryContradictions"));
    out.set("prComments", field("prComments"));
    (out, dropped)
}
