//! A finished run published on its PR after the fact (`craft review comment`), written into its
//! record as `applyPublication` in `integrations/shared/sorting-choice.mjs` writes it: the sorting, the findings
//! going against memory and what was posted replace the record's own, and each choice the reviewer
//! already recorded follows its finding — by file, line and title — to its number in the new
//! sorting; one whose finding is gone is dropped and named.

use std::path::Path;

use crate::cli_record::{publication_kept, unreadable_step};
use crate::js::{Js, JsString, Obj, Utf16Error, parse};
use crate::write::write_atomically;

fn sorting_of(r: &Obj) -> Option<&Obj> {
    r.get("sorting").and_then(Js::as_obj)
}

fn sorted_findings(sorting: Option<&Obj>) -> Vec<&Obj> {
    let list = sorting.and_then(|s| s.get("findings")).and_then(Js::as_arr);
    list.unwrap_or(&[]).iter().filter_map(Js::as_obj).collect()
}

/// `Number(v)` ([`Js::to_js_number`]), an absent value NaN as `Number(undefined)` is.
pub(crate) fn js_number(v: Option<&Js>) -> f64 {
    v.map_or(f64::NAN, Js::to_js_number)
}

/// `String(v ?? '')`.
fn string_or_empty(v: Option<&Js>) -> JsString {
    match v {
        None | Some(Js::Null) => JsString::default(),
        Some(v) => v.to_js_text(),
    }
}

/// A value in a template literal: `undefined` for what is absent.
fn templated(v: Option<&Js>) -> JsString {
    v.map_or_else(|| "undefined".into(), Js::to_js_text)
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

fn dropped_choice(n: &JsString, f: Option<&Obj>, c: &Js) -> Result<String, Utf16Error> {
    let what = match f {
        None => "no such finding".to_owned(),
        Some(f) => {
            format!(
                "{} @ {}:{}",
                templated(f.get("title")).to_utf8()?,
                templated(f.get("file")).to_utf8()?,
                templated(f.get("line")).to_utf8()?
            )
        }
    };
    let choice = string_or_empty(c.as_obj().and_then(|c| c.get("choice"))).to_utf8()?;
    Ok(format!("{} ({what}): {choice}", n.to_utf8()?))
}

/// The record's choices renumbered for `next`, `None` when none carries over, and those dropped.
fn carried_choices(
    record: &Obj,
    next: Option<&Obj>,
) -> Result<(Option<Obj>, Vec<String>), Utf16Error> {
    let Some(old) = sorting_of(record)
        .and_then(|s| s.get("choices"))
        .and_then(Js::as_obj)
    else {
        return Ok((None, Vec::new()));
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
            _ => dropped.push(dropped_choice(n, f, c)?),
        }
    }
    Ok(((!choices.is_empty()).then_some(choices), dropped))
}

/// The record with the publication `kept` written in, and the choices dropped.
/// # Errors
/// When a dropped choice cannot be reported through the Unicode-only warning surface.
pub fn apply(record: &Obj, kept: &Obj) -> Result<(Obj, Vec<String>), Utf16Error> {
    let next = kept.get("sorting").and_then(Js::as_obj);
    let (choices, dropped) = carried_choices(record, next)?;
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
    Ok((out, dropped))
}

/// The publication of a finished step written into the record already filed.
#[must_use]
pub fn answer(req: &Obj) -> Obj {
    let fail = |why: String| {
        Obj::new()
            .with("ok", Js::Bool(false))
            .with("reason", Js::str(why))
            .with("file", Js::str(""))
    };
    let file = match req.try_text("recordFile") {
        Ok(file) => file,
        Err(e) => return fail(e.to_string()),
    };
    if file.is_empty() {
        return fail("no record file was named".into());
    }
    let none = Obj::new();
    let step = req.get("step").and_then(Js::as_obj).unwrap_or(&none);
    if let Some(why) = unreadable_step(step) {
        return fail(format!("the finished step cannot be read: {why}"));
    }
    let read = std::fs::read_to_string(file).map_err(|e| e.to_string());
    let record = match read.and_then(|t| parse(&t).map_err(|e| e.to_string())) {
        Ok(Js::Obj(r)) => r,
        Ok(_) => return fail(not_readable(file, "not a JSON object")),
        Err(e) => return fail(not_readable(file, &e)),
    };
    let (amended, dropped) = match apply(&record, &publication_kept(step)) {
        Ok(result) => result,
        Err(e) => return fail(e.to_string()),
    };
    if let Err(e) = write_atomically(Path::new(file), Js::Obj(amended).pretty()) {
        return fail(format!("craft-log-run FAILED: {e}"));
    }
    let reason = if dropped.is_empty() {
        String::new()
    } else {
        format!(
            "dropped the choices of doubtful findings no longer listed: {}",
            dropped.join("; ")
        )
    };
    Obj::new()
        .with("ok", Js::Bool(true))
        .with("reason", Js::str(reason))
        .with("file", Js::str(file))
}

fn not_readable(file: &str, why: &str) -> String {
    format!("craft-log-run FAILED: record not readable at {file}: {why}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(record_file: &str) -> Obj {
        let step = Obj::new()
            .with("report", Js::str("/r/report.md"))
            .with("verdict", Js::str("Approve"));
        Obj::new()
            .with("recordFile", Js::str(record_file))
            .with("step", Js::Obj(step))
    }

    #[test]
    fn a_publication_with_no_record_or_one_that_cannot_be_read_is_a_failure_said() {
        let none = answer(&req(""));
        assert_eq!(none.text("reason").unwrap(), "no record file was named");
        assert_eq!(none.get("ok"), Some(&Js::Bool(false)));
        let d = tempfile::tempdir().unwrap();
        let torn = d.path().join("r.json");
        std::fs::write(&torn, "{\"verdict\":").unwrap();
        let said = answer(&req(&torn.display().to_string()));
        assert!(
            said.text("reason")
                .unwrap()
                .starts_with("craft-log-run FAILED: record not readable at"),
            "{}",
            said.text("reason").unwrap()
        );
        assert_eq!(
            std::fs::read_to_string(&torn).unwrap(),
            "{\"verdict\":",
            "left as it was"
        );
    }
}
