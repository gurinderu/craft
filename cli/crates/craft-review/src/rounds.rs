//! The lens rounds (`lensRoundsPhase` in `integrations/shared/review-lens-rounds.mjs`): every planned lens over
//! its profile's part of the diff, round after round, each told what the pool already holds, until
//! a round adds nothing new to its profile or the profile's plan's rounds are spent (loop until
//! dry). The profiles of a run share each round and the pool. A finding is new when no pooled
//! finding has its key (file, line and title); a lens dispatch that never returns is a hole the
//! verdict reads as INCOMPLETE.

use craft_store::js::JsStr;
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::agent::Model;
use crate::content::{self, ContentError};
use crate::harm::raise::{claim_count, group_claims};
use crate::plan::Plan;
use crate::profile::Profile;
use crate::prompts::{self, LensIn, PromptContext};
use crate::state::{Task, TaskKind, TaskState};
use crate::units::Slice;

/// What one round dispatched and what it added, as `lensRounds` records it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundYield {
    pub round: u32,
    pub agents: usize,
    pub returned: usize,
    pub new_findings: usize,
    /// Every finding the round's answers held, exact copies of pooled ones included; `None` in a
    /// state written before it was counted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<usize>,
}

/// The pool the rounds fill and the ledger of their dispatches.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rounds {
    /// The round under way, 0 before the first.
    pub round: u32,
    /// Every finding found so far, each once, its `source` the lens dispatched, its `profile` that
    /// lens's profile and its `foundInRound` the round that first found it.
    pub pool: Vec<Value>,
    pub yields: Vec<RoundYield>,
    /// The lenses dispatched, and those that answered at least once, each as `profile:lens`.
    pub expected: Vec<String>,
    pub returned: Vec<String>,
    /// Why each lens's last dispatch gave no answer, by `profile:lens`.
    pub failures: BTreeMap<String, String>,
    /// The CONSUMERS lines (`file:line`) some lens shown them marked.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub consumers_marked: Vec<String>,
    /// The CONSUMERS lines a taken lens answer left unmarked (realm @nick/craft, node #531).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub consumers_left: Vec<String>,
    /// The CONSUMERS lines some lens task's prompt showed, answered or not.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub consumers_shown: Vec<String>,
    /// The CONSUMERS lines shown to a lens task that did not answer: died, failed or still out.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub consumers_unanswered: Vec<String>,
}

/// The exact key of a finding: its file and title folded, and its line, as `key` in
/// `integrations/shared/review-run.mjs`.
#[must_use]
pub fn key(f: &Value) -> String {
    let s = |k: &str| {
        f.get(k)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase()
    };
    let line = f.get("line").and_then(Value::as_i64).unwrap_or(0);
    let title = s("title")
        .js_split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    format!("{}:{line}:{title}", s("file"))
}

/// What parts a sliced dispatch's key from its slice's, as `dispatchKey` in
/// `integrations/shared/review-lens-dispatch.mjs`: each slice of a lens is a dispatch of its own, and one that
/// never returned is a hole whatever its siblings did.
const SLICE_SEP: &str = " :: ";

/// A lens as the rounds key it: its profile and its id.
fn lens_key(profile: &str, lens: &str) -> String {
    format!("{profile}:{lens}")
}

/// One task per planned lens of `profile` for `round`, over the profile's part `files`, each told
/// what the pool holds and run on the profile's lens agent; a metrics-or-nothing lens in the first
/// round only. A sliceable lens runs once per slice of `slices` instead: the unit batches under unit
/// mode, else the normal mode's directory slices.
///
/// # Errors
/// When a prompt cannot be rendered or the findings schema read.
pub fn tasks(
    ctx: &PromptContext,
    at: (&Profile, &Plan),
    files: &[String],
    slices: &[Slice],
    rounds: &Rounds,
) -> Result<Vec<Task>, ContentError> {
    let (profile, plan) = at;
    let prior = prompts::prior_found_summary(&rounds.pool);
    let pathspec = ctx.pathspec(profile, files);
    let mut out = Vec::new();
    // A metrics lens reads numbers another round would not change, and the design lens decisions
    // another round would not change (realm @nick/craft, node #534): each runs in the first only.
    let once = |l: &str| l == crate::design::LENS || profile.lens(l).is_some_and(|x| x.metrics);
    let lenses = plan.lenses.iter().filter(|l| rounds.round <= 1 || !once(l));
    for lens in lenses {
        let at = LensIn {
            profile,
            lens,
            plan,
            pathspec: &pathspec,
            prior: &prior,
        };
        // A lens that judges the change as a whole (`WHOLE_DIFF_LENSES` in integrations/shared/lens-scope.mjs, the
        // profile's `wholeDiff`) or reads metrics is never sliced.
        let whole = profile.lens(lens).is_none_or(|l| l.metrics || l.whole_diff);
        if slices.is_empty() || whole {
            out.push(lens_task(ctx, &at, rounds.round, None)?);
            continue;
        }
        for (i, slice) in slices.iter().enumerate() {
            out.push(lens_task(ctx, &at, rounds.round, Some((i, slice)))?);
        }
    }
    Ok(out)
}

/// One lens dispatch: over its profile's whole part, or over the `i`-th slice.
fn lens_task(
    ctx: &PromptContext,
    at: &LensIn<'_>,
    round: u32,
    slice: Option<(usize, &Slice)>,
) -> Result<Task, ContentError> {
    let (profile, lens) = (at.profile, at.lens);
    let spec = profile.lens(lens);
    let model = spec.map_or(Model::Opus, |l| l.model);
    // A metrics-or-nothing lens's findings carry the numbers they rest on; a lens confined to a
    // unit batch answers with its questions about other units beside its findings.
    let schema = if spec.is_some_and(|l| l.metrics) {
        crate::complexity::findings_schema()?
    } else if slice.is_some_and(|(_, s)| !s.units.is_empty()) {
        content::schema("unit-findings")?
    } else {
        content::schema("findings")?
    };
    let (id, label, prompt) = match slice {
        None => (String::new(), String::new(), prompts::lens_prompt(ctx, at)?),
        Some((i, s)) => (
            format!("-s{i}"),
            format!(" {}", s.key),
            prompts::slice_lens_prompt(ctx, at, s)?,
        ),
    };
    let mut task = Task::new(
        format!("lens-{}-{lens}-r{round}{id}", profile.id),
        format!("lens:{}:{lens} r{round}{label}", profile.id),
        prompt,
        model,
        schema,
        TaskKind::Lens {
            profile: profile.id.clone(),
            lens: lens.to_owned(),
            round,
            slice: slice.map(|(_, s)| s.key.clone()),
        },
    );
    // Only the lenses name the profile's agent, and not a metrics lens, which judges from the
    // numbers in its prompt alone; the scout, the dedup and the verifiers name none, and each host
    // picks the agent for those.
    task.agent_type = profile.agent_of(lens);
    task.marks.consumers = crate::validate::listed(&task.prompt, &ctx.consumers);
    Ok(task)
}

/// Records on `kept` that another lens filed the very same finding, as `noteExactCopy`, and the
/// round the copy was raised in.
fn note_exact_copy(kept: &mut Value, copy: &Value) {
    let had = std::mem::take(kept);
    *kept = crate::dedup::with_rounds(had.clone(), &[&had, copy]);
    let src = |v: &Value| v.get("source").and_then(Value::as_str).map(str::to_owned);
    let Some(theirs) = src(copy).filter(|s| !s.is_empty()) else {
        return;
    };
    if src(kept).as_deref() == Some(theirs.as_str()) {
        return;
    }
    let mut had: Vec<Value> = match kept.get("sources").and_then(Value::as_array) {
        Some(a) => a.clone(),
        None => vec![kept.get("source").cloned().unwrap_or(Value::Null)],
    };
    let claims = group_claims([&*kept, copy]);
    let more = claims.len() > claim_count(kept);
    let Some(obj) = kept.as_object_mut() else {
        return;
    };
    if !had.contains(&Value::String(theirs.clone())) {
        had.push(Value::String(theirs));
        obj.insert("sources".into(), Value::Array(had));
    }
    if more {
        obj.insert("harmClaims".into(), Value::Array(claims));
    }
}

/// One lens finding as the pool keeps it: its lens as `source`, its profile, its first round.
fn pooled(found: &Value, profile: &str, lens: &str, round: u32) -> Value {
    let mut f: Map<String, Value> = found.as_object().cloned().unwrap_or_default();
    f.insert("source".into(), Value::String(lens.to_owned()));
    f.insert("profile".into(), Value::String(profile.to_owned()));
    f.insert("foundInRound".into(), Value::from(round));
    crate::dedup::stamped(Value::Object(f), crate::dedup::LENS, Some(round))
}

impl Rounds {
    /// Takes the answers of a round's lens tasks into the pool; returns how many new findings
    /// each profile that dispatched a lens added (none: that profile's loop is dry).
    pub fn absorb(&mut self, tasks: &[Task]) -> BTreeMap<String, usize> {
        let mut fresh: Vec<Value> = Vec::new();
        let mut added: BTreeMap<String, usize> = BTreeMap::new();
        let (mut returned, mut raw) = (0, 0);
        for t in tasks {
            let TaskKind::Lens {
                profile,
                lens,
                round,
                slice,
            } = &t.kind
            else {
                continue;
            };
            added.entry(profile.clone()).or_insert(0);
            let mut k = lens_key(profile, lens);
            if let Some(s) = slice {
                k = format!("{k}{SLICE_SEP}{s}");
            }
            let answer = self.answered(t, &k);
            self.note_lines(t, answer.is_some());
            let Some(answer) = answer else {
                continue;
            };
            returned += 1;
            let found = answer.get("findings").and_then(Value::as_array);
            for f in found.into_iter().flatten() {
                raw += 1;
                let f = pooled(f, profile, lens, *round);
                let at = key(&f);
                if let Some(g) = self
                    .pool
                    .iter_mut()
                    .chain(fresh.iter_mut())
                    .find(|g| key(g) == at)
                {
                    note_exact_copy(g, &f);
                } else {
                    fresh.push(f);
                    *added.entry(profile.clone()).or_insert(0) += 1;
                }
            }
        }
        self.yields.push(RoundYield {
            round: self.round,
            // The lens dispatches only: an extra lens beside the round is the consumer's agent.
            agents: tasks
                .iter()
                .filter(|t| matches!(t.kind, TaskKind::Lens { .. }))
                .count(),
            returned,
            new_findings: fresh.len(),
            raw: Some(raw),
        });
        self.pool.extend(fresh);
        added
    }

    /// Takes the CONSUMERS lines `other` (these rounds with more answers absorbed) holds as
    /// shown, marked and left; returns its pool.
    pub(crate) fn take_consumers(&mut self, other: Self) -> Vec<Value> {
        self.consumers_shown = other.consumers_shown;
        self.consumers_marked = other.consumers_marked;
        self.consumers_left = other.consumers_left;
        self.consumers_unanswered = other.consumers_unanswered;
        other.pool
    }

    /// Notes the CONSUMERS lines lens task `t` was shown: when it `answered`, those it marked and
    /// those it left; else as shown to a lens that did not answer.
    pub(crate) fn note_lines(&mut self, t: &Task, answered: bool) {
        for site in &t.marks.consumers {
            let into = if !answered {
                &mut self.consumers_unanswered
            } else if t.marks.unmarked.contains(site) {
                &mut self.consumers_left
            } else {
                &mut self.consumers_marked
            };
            for list in [into, &mut self.consumers_shown] {
                if !list.contains(site) {
                    list.push(site.clone());
                }
            }
        }
    }

    /// The CONSUMERS lines no lens shown them marked, in the order they were left.
    #[must_use]
    pub fn unmarked(&self) -> Vec<String> {
        self.consumers_left
            .iter()
            .filter(|s| !self.consumers_marked.contains(s))
            .cloned()
            .collect()
    }

    /// The CONSUMERS lines shown only to lens tasks that did not answer: no answered lens marked
    /// or left them.
    #[must_use]
    pub fn unanswered(&self) -> Vec<String> {
        self.consumers_unanswered
            .iter()
            .filter(|s| !self.consumers_marked.contains(s) && !self.consumers_left.contains(s))
            .cloned()
            .collect()
    }

    /// The lines of `listed` no lens task was shown, in `listed`'s order: under unit mode, those
    /// outside every confined lens's units, which only the seam pass reads.
    #[must_use]
    pub fn unshown(&self, listed: &[String]) -> Vec<String> {
        listed
            .iter()
            .filter(|s| !self.consumers_shown.contains(s))
            .cloned()
            .collect()
    }

    /// Records the dispatch of the lens keyed `k` and whether it answered; its answer if it did.
    fn answered<'t>(&mut self, t: &'t Task, k: &str) -> Option<&'t Value> {
        if !self.expected.iter().any(|e| e == k) {
            self.expected.push(k.to_owned());
        }
        let Some(answer) = t.answer.as_ref().filter(|_| t.state == TaskState::Answered) else {
            let why = t
                .error
                .clone()
                .unwrap_or_else(|| "returned no result (skipped or died without an error)".into());
            self.failures.insert(k.to_owned(), why);
            return None;
        };
        if !self.returned.iter().any(|r| r == k) {
            self.returned.push(k.to_owned());
        }
        Some(answer)
    }

    /// The lenses of `profile` that never answered in any round, each with why.
    #[must_use]
    pub fn holes(&self, profile: &str) -> Vec<String> {
        self.holes_of(profile).into_iter().map(|(_, h)| h).collect()
    }

    /// [`Self::holes`], each beside the id of the lens it is, its slice cut off.
    #[must_use]
    pub fn holes_of(&self, profile: &str) -> Vec<(String, String)> {
        let prefix = lens_key(profile, "");
        self.expected
            .iter()
            .filter(|k| !self.returned.contains(k))
            .filter_map(|k| {
                let lens = k.strip_prefix(&prefix)?;
                let why = self.failures.get(k).map_or(
                    "returned no result (skipped or died without an error)",
                    String::as_str,
                );
                let id = lens.split(SLICE_SEP).next().unwrap_or(lens);
                Some((id.to_owned(), format!("{lens}: {why}")))
            })
            .collect()
    }

    /// The lenses of `profile`'s plan that answered: a sliced one on every slice it was sent.
    #[must_use]
    pub fn ran(&self, profile: &str, plan: &Plan) -> Vec<String> {
        plan.lenses
            .iter()
            .filter(|l| {
                let k = lens_key(profile, l);
                let sliced = format!("{k}{SLICE_SEP}");
                let mut sent = self
                    .expected
                    .iter()
                    .filter(|e| **e == k || e.starts_with(&sliced))
                    .peekable();
                sent.peek().is_some() && sent.all(|e| self.returned.contains(e))
            })
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod shown_tests;
#[cfg(test)]
mod tests;
