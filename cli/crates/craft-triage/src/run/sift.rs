//! The Sift phase: repeats collapsed, then the project memory — the launcher's records, the recall
//! over the kept findings' files, the match judge, the rule judges — sets aside what it answers
//! (realm @nick/craft, nodes #305, #309).

use craft_review::memory::{Memory, PriorDecision, Scope};
use craft_store::js::Js;
use serde_json::Value;

use crate::TriageError;
use crate::finding::id_of;
use crate::kind::TriageKind;
use crate::memory::{NOT_RECALLED, NOTE, Settled, as_values, recall_paths, settled};
use crate::prompts::directive;
use crate::sift::{Collapsed, Sifted, collapse_repeats};

use super::gather::Got;
use super::{Answers, Args, Ask, Phase, Ready, sonnet};

/// What the sift left: the batch collapsed, the memory as it stands, and the batch settled by it.
#[derive(Debug, Clone)]
pub(crate) struct Sift {
    pub collapsed: Collapsed,
    pub memory: Memory,
    pub settled: Settled,
}

/// An answer as plain JSON.
fn plain(v: &Js) -> Value {
    serde_json::from_str(&v.compact()).unwrap_or(Value::Null)
}

/// The memory's ask as the triage asks it: pointed at the repository, on the cheap model.
fn asked(args: &Args, kind: TriageKind, a: craft_review::memory::Ask) -> Ask {
    let prompt = format!("{}{}", directive(&args.repo), a.prompt);
    sonnet(kind, &a.id, &a.label, prompt, a.schema)
}

/// The memory once the recall is in: the launcher's records merged with what it recalled for the
/// kept findings' files; none asked when no finding names a file.
fn recalled(
    args: &Args,
    answers: &dyn Answers,
    kept: &[Sifted],
) -> Result<Ready<Memory>, TriageError> {
    let mut memory = Memory::open(args.prior_decisions.clone());
    let paths = recall_paths(kept);
    if paths.is_empty() {
        memory.not_recalled(NOT_RECALLED);
        return Ok(Ready::Got(memory));
    }
    let (ask, cut) = Memory::recall_ask(&paths, &args.base)?;
    let kind = TriageKind::Recall {
        cut: cut.cut,
        grouped: cut.grouped,
    };
    let Some(answer) = answers.answer(&kind) else {
        return Ok(Ready::Ask(Phase::Recall, vec![asked(args, kind, ask)]));
    };
    memory.take_recalled(answer.as_ref().map(plain).as_ref(), cut, &paths);
    Ok(Ready::Got(memory))
}

/// The batch collapsed and sifted by the memory, or the memory's asks while any is not in.
///
/// # Errors
/// When a prompt or schema cannot be rendered.
pub(crate) fn sift(
    args: &Args,
    answers: &dyn Answers,
    got: &Got,
    scope: &dyn Fn(&[&PriorDecision]) -> Scope,
) -> Result<Ready<Sift>, TriageError> {
    let collapsed = collapse_repeats(
        got.raw
            .iter()
            .map(|f| Sifted::new(f.clone(), id_of(f)))
            .collect(),
    );
    let mut memory = match recalled(args, answers, &collapsed.kept)? {
        Ready::Got(m) => m,
        Ready::Ask(p, a) => return Ok(Ready::Ask(p, a)),
    };
    let values = as_values(&collapsed.kept);
    let judged = match memory.match_ask(&values, &[], scope)? {
        None => None,
        Some(ask) => match answers.answer(&TriageKind::MatchJudge) {
            None => {
                return Ok(Ready::Ask(
                    Phase::Match,
                    vec![asked(args, TriageKind::MatchJudge, ask)],
                ));
            }
            Some(a) => a.as_ref().map(plain),
        },
    };
    let mut decided = memory.decide(values, (judged.as_ref(), &[]), scope, NOTE);
    let asks = memory.rule_asks(&decided.kept, &[])?;
    let mut ruled = Vec::new();
    let mut missing = Vec::new();
    for (at, ask) in asks.into_iter().enumerate() {
        let kind = TriageKind::RuleJudge { at };
        match answers.answer(&kind) {
            None => missing.push(asked(args, kind, ask)),
            Some(a) => ruled.push(a.as_ref().map(plain)),
        }
    }
    if !missing.is_empty() {
        return Ok(Ready::Ask(Phase::Rules, missing));
    }
    let kept = std::mem::take(&mut decided.kept);
    let covered = memory.rule(kept, (&ruled, &[]), NOTE);
    let settled = settled(&collapsed.kept, decided, covered);
    Ok(Ready::Got(Sift {
        collapsed,
        memory,
        settled,
    }))
}
