//! A list of records read (`parsePriorDecisions` in `integrations/shared/prior-decisions.mjs`; realm @nick/craft,
//! node #218): under one cap, each refusal named by its label, a repeated id refused. The cap keeps
//! the run's state and the judges' prompts bounded; past it the records closest to the reviewed
//! paths are kept ([`super::super::bounds::kept_records`]), never simply the first in the list.

use serde_json::Value;

use super::super::bounds::kept_records;
use super::{PriorDecision, has_control, js_len, read, record_id};

/// The most records one run applies, recalled and passed together.
const PRIOR_DECISIONS_MAX: usize = 100;
/// What the refusal of the records past the cap says about how they were chosen and how to apply
/// them.
const CUT_HOW: &str = "kept are the records closest to the reviewed paths (a scope naming a changed file, then a directory holding one, a deeper scope before a shallower, a newer record before an older); to apply the rest, review a narrower path (path=<dir>) or supersede the records that no longer hold";

/// The records read from a list, and every refusal.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(in crate::memory) struct Parsed {
    pub decisions: Vec<PriorDecision>,
    pub refused: Vec<String>,
}

/// A refusal's label for the record at index `i` of a launcher's list.
pub(in crate::memory) fn plain_label(i: usize) -> String {
    format!("decision #{i}")
}

/// The record's id when it is fit to print, else ''.
fn printable_id(item: &Value) -> String {
    let id = item.as_object().map(record_id).unwrap_or_default();
    if js_len(&id) <= 80 && !has_control(&id) {
        id
    } else {
        String::new()
    }
}

/// The records past the cap (by their index in the list), each named, the names bounded by the
/// cap itself.
fn cut_names(list: &[Value], cut: &[usize], label_of: &dyn Fn(usize) -> String) -> String {
    let named: Vec<String> = cut
        .iter()
        .take(PRIOR_DECISIONS_MAX)
        .filter_map(|&i| {
            let id = printable_id(list.get(i)?);
            let tail = if id.is_empty() {
                String::new()
            } else {
                format!(" ({id})")
            };
            Some(format!("{}{tail}", label_of(i)))
        })
        .collect();
    let more = cut.len() - named.len();
    let tail = if more > 0 {
        format!(" and {more} more")
    } else {
        String::new()
    };
    format!("{}{tail}", named.join(", "))
}

/// A list of records read (`parsePriorDecisions`): absent, nothing; a string or any other non-list,
/// nothing applied and named; past the cap, those farthest from the reviewed `paths` named; a
/// repeated id refused.
pub(in crate::memory) fn parse(
    raw: Option<&Value>,
    paths: &[String],
    label_of: &dyn Fn(usize) -> String,
) -> Parsed {
    let mut out = Parsed::default();
    let list = match raw {
        None | Some(Value::Null) => return out,
        Some(Value::String(s)) if s.is_empty() => return out,
        Some(Value::String(_)) => {
            out.refused.push("priorDecisions arrived as a string — only a list inside an object argument is read (in a key=value string nothing from priorDecisions on was read as an option) — no decision applied".into());
            return out;
        }
        Some(Value::Array(list)) => list,
        Some(Value::Bool(_) | Value::Number(_) | Value::Object(_)) => {
            out.refused
                .push("priorDecisions is not a list — no decision applied".into());
            return out;
        }
    };
    let kept = kept_records(list, paths, PRIOR_DECISIONS_MAX);
    let mut cut = Vec::new();
    for (i, item) in list.iter().enumerate() {
        if !kept.get(i).copied().unwrap_or(false) {
            cut.push(i);
            continue;
        }
        match read(item, &label_of(i)) {
            Err(why) => out.refused.push(why),
            Ok(d) if out.decisions.iter().any(|x| x.id == d.id) => out.refused.push(format!(
                "{} ({}) repeats an id already given — not applied",
                label_of(i),
                d.id
            )),
            Ok(d) => out.decisions.push(d),
        }
    }
    if !cut.is_empty() {
        out.refused.push(format!(
            "{} decision(s) past the cap of {PRIOR_DECISIONS_MAX} were not applied — {CUT_HOW}; findings they would answer are raised normally: {}",
            cut.len(),
            cut_names(list, &cut, label_of)
        ));
    }
    out
}
