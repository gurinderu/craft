//! The agents of one Workflow run, as enrich-cost slices them (realm @nick/craft, node #393): when
//! each started, the engine it ran under, and the record it filed. Read off the harness's files —
//! `agent-*.jsonl` transcripts and `agent-*.meta.json` (`description`, `workflowPhase`), Claude Code
//! 2.1.x (realm @nick/craft, node #98).

use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;

use crate::js::{Js, parse};

/// One agent of the run.
#[derive(Debug, Clone, PartialEq)]
pub struct RunAgent {
    pub name: String,
    /// Milliseconds since the epoch.
    pub start: f64,
    /// The record its logger or binary step filed, `""` when none.
    pub record: String,
    /// The nested engine's phase, `""` for the top-level engine.
    pub instance: String,
    pub engine: String,
}

/// A literal pattern, compiled once; the tests below hold each one to compile.
type Pattern = LazyLock<Option<Regex>>;

fn re(pattern: &str) -> Option<Regex> {
    Regex::new(pattern).ok()
}

fn is_match(p: &Pattern, text: &str) -> bool {
    p.as_ref().is_some_and(|r| r.is_match(text))
}

/// The logger agent's label, as `logRunDispatch` names it: `log-run`, or `log-run (<n>KB)`.
static LOG_RUN: Pattern = LazyLock::new(|| re(r"^log-run(?: \([0-9]+KB\))?$"));
/// What craft-log-run prints for a filed record (`write`/`finalize`, or a proven retry).
static FILED: Pattern =
    LazyLock::new(|| re(r"(?mR)^(?:wrote|already filed) (/.+?\.json)(?: \(.*\))?$"));
/// A binary step whose segment's own work it filed, and a same-run recovery of a lost submit.
static OWN_STEP: Pattern = LazyLock::new(|| re(r"^step:(?:start|resume|submit:[0-9]+)$"));
static RECOVERY_STEP: Pattern = LazyLock::new(|| re(r"^step:(?:status|refile)$"));
/// The record file a binary step's `filing` names, as the JSON string literal it prints. A
/// resume's `refiledFile` is a later run's re-file of an earlier run's record and takes none of
/// this run's cost (realm @nick/craft, nodes #393, #389).
static OWN_KEY: Pattern = LazyLock::new(|| re(r#""recordFile":("(?:[^"\\]|\\.)*")"#));
static ANY_KEY: Pattern =
    LazyLock::new(|| re(r#""(?:recordFile|refiledFile)":("(?:[^"\\]|\\.)*")"#));
/// The phase the harness gives every agent of a nested workflow: `▸ craft:review`, `▸ craft:review #2`.
static NESTED_PHASE: Pattern =
    LazyLock::new(|| re(r"^▸ (?:[A-Za-z0-9_.-]+:)?([A-Za-z0-9_.-]+?)(?: #[0-9]+)?$"));

/// The last record file `text` says craft-log-run filed, `""` when none.
fn filed_in(text: &str) -> String {
    let last = FILED
        .as_ref()
        .and_then(|r| r.captures_iter(text).filter_map(|c| c.get(1)).last());
    last.map_or_else(String::new, |m| m.as_str().to_owned())
}

/// The last record file a binary step's output names under `keys`, `""` when none.
fn named_in(keys: &Pattern, text: &str) -> String {
    let mut file = String::new();
    let Some(keys) = keys.as_ref() else {
        return file;
    };
    for c in keys.captures_iter(text) {
        if let Some(Ok(Js::Str(s))) = c.get(1).map(|m| parse(m.as_str()))
            && let Ok(s) = s.to_utf8()
        {
            file = s;
        }
    }
    file
}

/// The nested engine a phase names: its instance (the phase itself) and the engine's name.
#[must_use]
pub fn engine_of_phase(phase: Option<&Js>) -> (String, String) {
    let phase = match phase {
        None | Some(Js::Null) => String::new(),
        Some(v) => v.to_js_text().to_utf8().unwrap_or_default(),
    };
    match NESTED_PHASE
        .as_ref()
        .and_then(|r| r.captures(&phase))
        .and_then(|c| c.get(1))
    {
        Some(m) => {
            let engine = m.as_str().to_owned();
            (phase, engine)
        }
        None => (String::new(), String::new()),
    }
}

/// The text of a tool result's content: a string, or the text of its text blocks.
fn result_text(content: Option<&Js>) -> String {
    match content {
        Some(Js::Str(s)) => s.to_utf8().unwrap_or_default(),
        Some(Js::Arr(blocks)) => blocks
            .iter()
            .map(|b| match b.as_obj().and_then(|b| b.get("text")) {
                Some(Js::Str(t)) => t.to_utf8().unwrap_or_default(),
                _ => String::new(),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// The record file the agent's tool results name last, read by `read`.
fn filed_record(lines: &[Option<Js>], read: &dyn Fn(&str) -> String) -> String {
    let mut file = String::new();
    for rec in lines.iter().flatten() {
        let Some(rec) = rec
            .as_obj()
            .filter(|r| r.get("type").and_then(Js::as_str) == Some("user"))
        else {
            continue;
        };
        let content = rec
            .get("message")
            .and_then(Js::as_obj)
            .and_then(|m| m.get("content"));
        for block in content.and_then(Js::as_arr).unwrap_or(&[]) {
            let Some(block) = block.as_obj() else {
                continue;
            };
            if block.get("type").and_then(Js::as_str) == Some("tool_result") {
                let named = read(&result_text(block.get("content")));
                if !named.is_empty() {
                    file = named;
                }
            }
        }
    }
    file
}

fn record_of(label: &str, lines: &[Option<Js>]) -> String {
    if is_match(&LOG_RUN, label) {
        filed_record(lines, &filed_in)
    } else if is_match(&OWN_STEP, label) {
        filed_record(lines, &|t| named_in(&OWN_KEY, t))
    } else if is_match(&RECOVERY_STEP, label) {
        filed_record(lines, &|t| named_in(&ANY_KEY, t))
    } else {
        String::new()
    }
}

/// One agent of the run: its transcript, when it started (its first timestamped line, else the
/// file's mtime), the nested engine it ran under, and the record it filed.
#[must_use]
pub fn read_agent(run_dir: &Path, name: &str) -> RunAgent {
    let file = run_dir.join(name);
    let text = std::fs::read(&file)
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_default();
    let lines: Vec<Option<Js>> = text
        .split('\n')
        .filter(|l| !l.trim().is_empty())
        .map(|l| parse(l).ok())
        .collect();
    let stamped = lines.iter().find_map(|r| {
        let ts = r.as_ref()?.as_obj()?.get("timestamp")?.as_str()?;
        super::date::parse_ms(ts)
    });
    let start = stamped.unwrap_or_else(|| {
        std::fs::metadata(&file)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
    });
    let meta_name = name
        .strip_suffix(".jsonl")
        .map_or_else(|| name.to_owned(), |n| format!("{n}.meta.json"));
    let meta = std::fs::read_to_string(run_dir.join(meta_name))
        .ok()
        .and_then(|t| parse(&t).ok());
    let meta = meta.as_ref().and_then(Js::as_obj);
    let label = match meta.and_then(|m| m.get("description")) {
        None | Some(Js::Null) => String::new(),
        Some(v) => v.to_js_text().to_utf8().unwrap_or_default(),
    };
    let (instance, engine) = engine_of_phase(meta.and_then(|m| m.get("workflowPhase")));
    RunAgent {
        name: name.to_owned(),
        start,
        record: record_of(&label, &lines),
        instance,
        engine,
    }
}

#[cfg(test)]
mod tests;
