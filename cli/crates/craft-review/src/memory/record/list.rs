//! A list of records read (`parsePriorDecisions` in `integrations/shared/prior-decisions.mjs`; realm @nick/craft,
//! node #218): under one cap, the project rules counted apart under a cap of their own (node #273),
//! each refusal named by its label, a repeated id refused. The cap keeps the run's state and the
//! judges' prompts bounded; past it the decisions closest to the reviewed paths are kept
//! ([`super::super::bounds::kept_records`]), never simply the first in the list.

use serde_json::Value;

use super::super::bounds::kept_records;
use super::{PriorDecision, has_control, read, record_id, record_kind};

/// The most records one run applies, recalled and passed together — and, apart, the most project
/// rules: a project holds few, and the decisions piled up on its paths must not push them out.
const PRIOR_DECISIONS_MAX: usize = 100;
/// What the refusal of the records past the cap says about how they were chosen and how to apply
/// them.
const CUT_HOW: &str = "kept are the records closest to the reviewed paths (a scope naming a changed file, then a directory holding one, a deeper scope before a shallower, a newer record before an older); to apply the rest, review a narrower path (path=<dir>) or supersede the records that no longer hold";
/// The same, for a list read with no reviewed paths: kept by the records' own scopes alone.
const CUT_HOW_PATHLESS: &str = "no reviewed paths are given here, so kept are the records with a scope before those over the whole repository, a deeper scope before a shallower, a newer record before an older; to apply the rest, review a narrower path (path=<dir>) or supersede the records that no longer hold";

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
    if crate::js::len(&id) <= 80 && !has_control(&id) {
        id
    } else {
        String::new()
    }
}

/// The records of `list` at the indices past the cap, each named, the names bounded by the cap
/// itself.
fn cut_names(list: &[Value], cut: &[usize], label_of: &dyn Fn(usize) -> String) -> String {
    let named: Vec<String> = cut
        .iter()
        .take(PRIOR_DECISIONS_MAX)
        .map(|&i| {
            let id = list.get(i).map(printable_id).unwrap_or_default();
            let tail = if id.is_empty() {
                String::new()
            } else {
                format!(" ({id})")
            };
            format!("{}{tail}", label_of(i))
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
    let caps = Caps::of(list, paths);
    for &i in &caps.read {
        let Some(item) = list.get(i) else { continue };
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
    if !caps.cut.is_empty() {
        out.refused.push(format!(
            "{} decision(s) past the cap of {PRIOR_DECISIONS_MAX} were not applied — {}; findings they would answer are raised normally: {}",
            caps.cut.len(),
            if paths.is_empty() { CUT_HOW_PATHLESS } else { CUT_HOW },
            cut_names(list, &caps.cut, label_of)
        ));
    }
    if !caps.cut_rules.is_empty() {
        out.refused.push(format!(
            "{} project rule(s) past the cap of {PRIOR_DECISIONS_MAX} were not applied — findings they would cover are raised normally: {}",
            caps.cut_rules.len(),
            cut_names(list, &caps.cut_rules, label_of)
        ));
    }
    out
}

/// The indices of a list read, in its order, and those past the caps: the project rules counted
/// apart from the other records, each under [`PRIOR_DECISIONS_MAX`] (`underCaps`); past it the
/// decisions closest to the reviewed `paths` are kept, the rules in the order given.
struct Caps {
    read: Vec<usize>,
    cut: Vec<usize>,
    cut_rules: Vec<usize>,
}

impl Caps {
    fn of(list: &[Value], paths: &[String]) -> Self {
        let is_rule = |x: &Value| x.as_object().is_some_and(|o| record_kind(o) == "rule");
        let (rules, others): (Vec<usize>, Vec<usize>) =
            (0..list.len()).partition(|&i| list.get(i).is_some_and(is_rule));
        let split = |v: Vec<usize>| {
            let at = v.len().min(PRIOR_DECISIONS_MAX);
            let (head, tail) = v.split_at(at);
            (head.to_vec(), tail.to_vec())
        };
        let others_list: Vec<Value> = others
            .iter()
            .filter_map(|&i| list.get(i).cloned())
            .collect();
        let kept = kept_records(&others_list, paths, PRIOR_DECISIONS_MAX);
        let (mut read, mut cut) = (Vec::new(), Vec::new());
        for (&i, &k) in others.iter().zip(&kept) {
            if k { read.push(i) } else { cut.push(i) }
        }
        let (rules, cut_rules) = split(rules);
        read.extend(rules);
        read.sort_unstable();
        Self {
            read,
            cut,
            cut_rules,
        }
    }
}
