//! A job's `run:` lines whose failure fails it (realm @nick/craft, node #482): none from a step
//! or a job with a `continue-on-error:` that is not `false` (an expression may be true), and an
//! inline plain value cut at its ` #` comment while a quoted one keeps its text.

use super::shell::joined;
use super::workflow::{indent, meaningful, step_key, unquote};

/// Whether a `continue-on-error:` key line says anything but `false`.
fn tolerant(rest: &str) -> bool {
    rest.strip_prefix("continue-on-error:")
        .is_some_and(|v| unquote(v.split(" #").next().unwrap_or(v).trim()) != "false")
}

/// Whether the job whose keys sit at column `at` among `lines` continues on error.
pub(super) fn job_tolerant(lines: &[&str], at: usize) -> bool {
    lines.iter().any(|l| indent(l) == at && tolerant(l.trim()))
}

/// Whether the step whose keys sit at column `col`, around line `i` of `lines`, continues on error.
fn step_tolerant(lines: &[&str], i: usize, col: usize) -> bool {
    let item = |l: &&str| l.trim_start().starts_with("- ") && step_key(l).0 == col;
    let begin = lines
        .get(..=i)
        .and_then(|head| head.iter().rposition(item))
        .unwrap_or(i);
    lines
        .iter()
        .skip(begin)
        .enumerate()
        .take_while(|(k, l)| *k == 0 || !meaningful(l) || indent(l) >= col)
        .any(|(_, l)| {
            let (c, rest) = step_key(l);
            c == col && tolerant(rest)
        })
}

/// An inline value: a quoted one's text, a plain one up to its ` #` comment.
fn inline(v: &str) -> &str {
    for q in ['"', '\''] {
        if let Some(text) = v
            .strip_prefix(q)
            .and_then(|r| r.find(q).and_then(|end| r.get(..end)))
        {
            return text;
        }
    }
    v.split(" #").next().unwrap_or(v).trim()
}

/// Each command line of the `run:` keys among `lines` whose failure fails the job: an inline value
/// as one line, a literal block (`|`) line by line with its `\` continuations joined, a folded one
/// (`>`) as one line; an empty value (`defaults: run:`, a mapping) is none.
pub(super) fn runs(lines: &[&str]) -> Vec<String> {
    let mut out = Vec::new();
    for (i, l) in lines.iter().enumerate() {
        let (col, rest) = step_key(l);
        let Some(value) = rest.strip_prefix("run:").map(str::trim) else {
            continue;
        };
        if value.is_empty() || step_tolerant(lines, i, col) {
            continue;
        }
        if !value.starts_with(['|', '>']) {
            out.push(inline(value).to_owned());
            continue;
        }
        let block: Vec<&str> = lines
            .iter()
            .skip(i + 1)
            .take_while(|b| b.trim().is_empty() || indent(b) > col)
            .map(|b| b.trim())
            .filter(|b| !b.is_empty() && !b.starts_with('#'))
            .collect();
        if value.starts_with('>') {
            out.push(block.join(" "));
        } else {
            out.extend(joined(&block));
        }
    }
    out
}
