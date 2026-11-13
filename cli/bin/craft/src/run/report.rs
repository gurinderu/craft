//! The answer `craft review run` prints, as the review's other drivers print it (lib/cli-review-verdict.mjs):
//! a `## Verdict` block whose first line is the verdict, marked with its glyph, then where the report
//! is, what publishing on the PR did, how the run ran weaker than asked, its stop and how to resume
//! it; the report's memory part verbatim; and a `## Findings` list, one line each. A parent reads
//! the stop by `stopped: usage limit reached (<text>)` (realm @nick/craft, nodes #298, #453).

use std::collections::HashMap;

use serde_json::Value;

/// A step's text field, "" when absent.
pub(super) fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// A non-negative whole number, 0 for anything else.
fn tally(v: Option<&Value>) -> u64 {
    v.and_then(Value::as_u64).unwrap_or(0)
}

/// Whitespace runs as one space, trimmed.
fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The line with its verdict's glyph, unless it opens with one already.
fn marked(line: &str) -> String {
    if !line.starts_with(|c: char| c.is_ascii_alphabetic()) {
        return line.to_owned();
    }
    let word = line.split(|c: char| !c.is_ascii_alphanumeric()).next();
    let clean = !line.contains("INCOMPLETE") && !line.contains("PARTIAL COVERAGE");
    match word {
        Some("Block") => format!("⛔ {line}"),
        Some("Approve") if clean => format!("✅ {line}"),
        _ => format!("⚠️ {line}"),
    }
}

fn block(line: &str, rest: &[String]) -> String {
    let mut out = vec!["## Verdict".to_owned(), String::new(), marked(line)];
    for r in rest {
        out.push(String::new());
        out.push(r.clone());
    }
    out.join("\n")
}

/// A run that did not finish: INCOMPLETE, and why.
pub(crate) fn stopped_answer(why: &str) -> String {
    block(&format!("INCOMPLETE — {why}"), &[])
}

/// How to resume the stopped run in `run`: this command again, or the binary's own submit.
pub(crate) fn resume_hint(run: &str, again: &str) -> String {
    let quoted = run.replace('\'', r"'\''");
    format!(
        "To resume it once agents can answer again: {again}, or the binary `craft review submit --run '{quoted}' --resume`."
    )
}

/// What came of publishing on the PR; nothing for a run that published nothing.
fn publication(step: &Value) -> Vec<String> {
    let Some(p) = step.get("prComments").filter(|p| p.is_object()) else {
        return Vec::new();
    };
    let error = text(p, "error");
    let (posted, already) = (tally(p.get("posted")), tally(p.get("already")));
    let requested = tally(p.get("requested"));
    let mark = if !error.is_empty() || posted + already < requested {
        "⚠️ "
    } else {
        ""
    };
    let gh = if !error.is_empty() && error != text(p, "reason") {
        format!(" (gh: {error})")
    } else {
        String::new()
    };
    let reason = text(p, "reason");
    let mut out = vec![format!(
        "{mark}PR comments: {posted} of {requested} defect(s) posted, {already} already on the PR — {reason}{gh}."
    )];
    let held = tally(step.get("sorting").and_then(|s| s.get("doubtful")));
    if held > 0 {
        out.push(format!("Doubtful: {held} finding(s) held back from the PR — the report's Doubtful section lists them for the human to choose; post a chosen one only through the craft:addressing-findings posting script."));
    }
    out
}

/// The binary's stop as a parent reads it, "" when the run did not stop.
fn stop_note(step: &Value) -> String {
    let Some(s) = step.get("stopped").filter(|s| s.is_object()) else {
        return String::new();
    };
    let said = text(s, "text");
    match text(s, "cause") {
        _ if said.is_empty() => String::new(),
        "limit" => format!("stopped: usage limit reached ({said})"),
        "deaths" => format!("stopped: {said}"),
        _ => String::new(),
    }
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// The finished run: its verdict line, where its report is, and its findings.
pub(crate) fn finished_answer(step: &Value, again: &str) -> String {
    let run = text(step, "run");
    let line = match text(step, "line") {
        "" => text(step, "verdict"),
        l => l,
    };
    let mut rest = vec![format!(
        "The report is {} — read that file for the findings (run {run}).",
        text(step, "report")
    )];
    rest.extend(publication(step));
    if let Some(line) = step.get("worktree").and_then(Value::as_str) {
        rest.push(format!("{line}."));
    }
    let notes = strings(step.get("degraded"));
    if !notes.is_empty() {
        let mut d = vec!["⚠️ Degraded: part of this review ran weaker than asked — the report's Degraded section says how.".to_owned()];
        d.extend(notes.iter().map(|n| format!("- {}", one_line(n))));
        rest.push(d.join("\n"));
    }
    let stopped = stop_note(step);
    if !stopped.is_empty() && !line.contains(&stopped) {
        rest.push(format!("{stopped}."));
    }
    if step.get("stopped").is_some_and(Value::is_object) {
        rest.push(resume_hint(run, again));
    }
    let memory = text(step, "memorySections").trim();
    let memory = if memory.is_empty() {
        String::new()
    } else {
        format!("{memory}\n\n")
    };
    format!("{}\n\n{memory}{}", block(line, &rest), findings(step))
}

/// The reported findings, one line each: severity, `file:line`, title and tier.
fn findings(step: &Value) -> String {
    let rows: Vec<String> = step
        .get("findings")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .map(|f| {
            let severity = match one_line(text(f, "severity")) {
                s if s.is_empty() => "unrated".to_owned(),
                s => s,
            };
            let at = match f.get("line").and_then(Value::as_u64) {
                Some(n) if n > 0 => format!(":{n}"),
                _ => String::new(),
            };
            let tier = match one_line(text(f, "tier")) {
                t if t.is_empty() => String::new(),
                t => format!(" ({t})"),
            };
            let (file, title) = (one_line(text(f, "file")), one_line(text(f, "title")));
            format!("- [{severity}] {file}{at} — {title}{tier}")
        })
        .collect();
    let body = if rows.is_empty() {
        "None reported.".to_owned()
    } else {
        rows.join("\n")
    };
    format!("## Findings\n\n{body}")
}

/// Whether a finished run's work was cut short: INCOMPLETE anywhere in its verdict, unless it
/// ended on nothing to review.
pub(crate) fn cut_short(verdict: &str) -> bool {
    const NOTHING: [&str; 2] = [
        "INCOMPLETE (empty diff)",
        "INCOMPLETE (no language profile)",
    ];
    verdict.contains("INCOMPLETE") && !NOTHING.contains(&verdict.trim())
}

/// How many distinct error lines the section names.
const SAID_SHOWN: usize = 3;

/// What the run's dead agents last wrote: the distinct lines, the most frequent first, at most
/// three, each with its count; "" when none was heard.
pub(crate) fn said_section(said: &HashMap<String, u64>) -> String {
    if said.is_empty() {
        return String::new();
    }
    let mut lines: Vec<(&String, &u64)> = said.iter().collect();
    lines.sort_by(|a, b| b.1.cmp(a.1).then_with(|| a.0.cmp(b.0)));
    let rows: Vec<String> = lines
        .into_iter()
        .take(SAID_SHOWN)
        .map(|(line, n)| format!("- {n} task(s): `{}`", line.replace('`', "'")))
        .collect();
    format!(
        "## What the agents said\n\nThe tasks that gave no answer last wrote:\n\n{}",
        rows.join("\n")
    )
}

#[cfg(test)]
#[path = "report_tests.rs"]
mod tests;
