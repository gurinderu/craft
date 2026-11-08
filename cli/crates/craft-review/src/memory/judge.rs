//! The memory's two judges, as `lib/prior-decision-match.mjs` and `lib/project-rule-judge.mjs`
//! ask them (realm @nick/craft, nodes #230, #231, #273, #282): ONE cheap agent per run is handed
//! every record–finding pair as one JSON block of quoted data, never a record's body, and returns
//! one verdict per pair — the same defect (`same`) or under the rule (`covered`), and whether the
//! finding shows the code going against the record (`violates`). A pair with no verdict decides
//! nothing on the judge's word.

use std::collections::BTreeMap;

use serde_json::Value;

use super::PriorDecision;
use crate::agent::Model;
use crate::content::{self, ContentError, vars};
use crate::state::{Task, TaskKind};
use crate::tool::finding_lenses;

mod contradiction;
mod pairs;

pub(crate) use contradiction::{contradiction_of, contradiction_record};
pub(super) use contradiction::{contradiction_section, mark_contradicting};
pub(super) use pairs::{match_pairs_json, rule_pairs_json};

/// The most pairs one judge sees; the rest are named and decided without it.
pub(super) const PAIRS_MAX: usize = 40;
/// How much of a model's or a record's line enters a pair or a note.
pub(super) const WHY_MAX: usize = 200;
/// How much of a finding's rationale enters a pair.
const BODY_MAX: usize = 800;
/// How many findings a note names before it counts the rest.
pub(super) const CUT_NAMED_MAX: usize = 10;

/// One verdict of a judge: `same` is the match judge's `same` or the rule judge's `covered`, false
/// whenever `violates` is true.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Verdict {
    pub same: bool,
    pub violates: bool,
    pub why: String,
}

/// A value as JavaScript's `String(v ?? '')` writes the scalars a finding carries.
pub(super) fn plain(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

/// One line of model or record text, its whitespace collapsed, cut at `max` UTF-16 units as
/// `clipLine` cuts it.
pub(super) fn clip(s: &str, max: usize) -> String {
    let one = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.encode_utf16().count() <= max {
        return one;
    }
    let mut n = 0;
    let cut: String = one
        .chars()
        .take_while(|c| {
            n += c.len_utf16();
            n <= max
        })
        .collect();
    format!("{cut}…")
}

/// A finding's field clipped to [`WHY_MAX`].
pub(super) fn clip_field(f: &Value, k: &str) -> String {
    clip(&plain(f.get(k)), WHY_MAX)
}

/// A finding's line when it is a positive whole number, else 0 (`findingLine`).
pub(super) fn line_of(f: &Value) -> u64 {
    match f.get("line") {
        Some(Value::Number(n)) => n.as_u64().unwrap_or(0),
        Some(Value::String(s)) => s.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

/// The lenses a finding names, each once, in order, joined as the pairs show them.
pub(super) fn lenses_text(f: &Value) -> String {
    let mut seen: Vec<String> = Vec::new();
    for l in finding_lenses(f) {
        if !seen.contains(&l) {
            seen.push(l);
        }
    }
    seen.join(", ")
}

/// A finding's rationale as a pair carries it: its `why`, else its `description`.
pub(super) fn body_of(f: &Value) -> String {
    let why = f.get("why").filter(|v| !v.is_null());
    clip(&plain(why.or_else(|| f.get("description"))), BODY_MAX)
}

/// A finding as a note names it (`ruleFindingName`).
pub(super) fn finding_name(f: &Value) -> String {
    format!(
        "\"{}\" @ {}:{}",
        clip(&plain(f.get("title")), 60),
        clip_field(f, "file"),
        line_of(f)
    )
}

/// One verdict as the judge returned it, `None` off-shape or outside `0..n` (`judgeVerdict`).
fn verdict(v: &Value, n: usize, key: &str) -> Option<(usize, Verdict)> {
    let i = v.get("pair").and_then(Value::as_u64)?;
    let i = usize::try_from(i).ok().filter(|i| *i < n)?;
    let same = v.get(key).and_then(Value::as_bool)?;
    let violates = v.get("violates") == Some(&Value::Bool(true));
    let why = clip(&plain(v.get("why")), WHY_MAX);
    let why = if why.is_empty() {
        "no reason given".to_owned()
    } else {
        why
    };
    // A contradiction wins: the pair is not the same, so it never sets a finding aside.
    Some((
        i,
        Verdict {
            same: same && !violates,
            violates,
            why,
        },
    ))
}

/// The judge's verdicts by pair index, `None` when it gave no answer or no verdict list
/// (`readJudge`); a verdict off-shape, out of range or repeating a pair is ignored.
pub(super) fn read(raw: Option<&Value>, n: usize, key: &str) -> Option<BTreeMap<usize, Verdict>> {
    let list = raw?.get("verdicts")?.as_array()?;
    let mut out = BTreeMap::new();
    for (i, v) in list.iter().filter_map(|v| verdict(v, n, key)) {
        out.entry(i).or_insert(v);
    }
    Some(out)
}

/// What a judge is asked: its task's id and label, template, schema and kind.
#[derive(Debug, Clone, Copy)]
pub(super) enum Judge {
    Match,
    Rule,
}

impl Judge {
    fn name(self) -> &'static str {
        match self {
            Self::Match => "match-judge",
            Self::Rule => "rule-judge",
        }
    }

    /// The prompt over `pairs`, the JSON block the pairs' builder rendered.
    ///
    /// # Errors
    /// When the template is missing.
    pub(super) fn prompt(self, pairs: &str) -> Result<String, ContentError> {
        content::prompt(self.name(), &vars([("pairs", pairs.to_owned())]))
    }

    /// The task asking it about `pairs`, on the cheap model the engine asks it on.
    ///
    /// # Errors
    /// When the template or the schema is missing.
    pub(super) fn task(self, pairs: &str) -> Result<Task, ContentError> {
        let (label, kind) = match self {
            Self::Match => ("decision-match", TaskKind::MatchJudge),
            Self::Rule => ("rule-match", TaskKind::RuleJudge),
        };
        Ok(Task::new(
            self.name().into(),
            label.into(),
            self.prompt(pairs)?,
            Model::Sonnet,
            content::schema(self.name())?,
            kind,
        ))
    }
}

/// The record at index `c` names among `ds`, with the judge's why.
pub(super) fn record_at<'a>(
    ds: &'a [PriorDecision],
    c: Option<&'a (usize, String)>,
) -> Option<(&'a PriorDecision, &'a str)> {
    let (at, why) = c?;
    Some((ds.get(*at)?, why.as_str()))
}
