//! A list of records read (`parsePriorDecisions` in `lib/prior-decisions.mjs`; realm @nick/craft,
//! node #218): under one cap, each refusal named by its label, a repeated id refused.

use serde_json::Value;

use super::{PriorDecision, has_control, js_len, read, record_id};

/// The most records one run applies, recalled and passed together.
const PRIOR_DECISIONS_MAX: usize = 100;

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

/// The records past the cap, each named, the names bounded by the cap itself.
fn cut_names(cut: &[Value], label_of: &dyn Fn(usize) -> String) -> String {
    let named: Vec<String> = cut
        .iter()
        .take(PRIOR_DECISIONS_MAX)
        .enumerate()
        .map(|(k, item)| {
            let id = printable_id(item);
            let tail = if id.is_empty() {
                String::new()
            } else {
                format!(" ({id})")
            };
            format!("{}{tail}", label_of(PRIOR_DECISIONS_MAX + k))
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
/// nothing applied and named; past the cap, the rest named; a repeated id refused.
pub(in crate::memory) fn parse(raw: Option<&Value>, label_of: &dyn Fn(usize) -> String) -> Parsed {
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
    for (i, item) in list.iter().take(PRIOR_DECISIONS_MAX).enumerate() {
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
    if let Some(cut) = list.get(PRIOR_DECISIONS_MAX..).filter(|c| !c.is_empty()) {
        out.refused.push(format!(
            "{} decision(s) past the cap of {PRIOR_DECISIONS_MAX} were not applied — findings they would answer are raised normally: {}",
            cut.len(),
            cut_names(cut, label_of)
        ));
    }
    out
}
