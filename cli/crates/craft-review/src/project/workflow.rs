//! A GitHub Actions workflow file read for what the CI map needs (realm @nick/craft, node #482):
//! each job under `jobs:` with its own `name:`, whether it runs a matrix, its `run:` lines and the
//! local actions or reusable workflows its `uses: ./…` runs. A
//! line reader, not a YAML parser: workflow files are indented blocks, and these three keys sit at
//! places their indent finds — no dependency is taken for them. What it misreads (anchors, flow
//! mappings) only costs a candidate, which the reviewer confirms in words before it is recorded.

use super::shell::joined;

/// One job of a workflow: its id, its `name:` when it has one, whether a `matrix:` expands it,
/// each command line of its steps' `run:`, and each local path a `uses: ./…` names, without `./`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Job {
    pub id: String,
    pub name: Option<String>,
    pub matrix: bool,
    pub runs: Vec<String>,
    pub uses: Vec<String>,
}

fn indent(l: &str) -> usize {
    l.len() - l.trim_start().len()
}

/// Neither blank nor a comment.
fn meaningful(l: &str) -> bool {
    let t = l.trim();
    !t.is_empty() && !t.starts_with('#')
}

/// The key a `key:` line opens with nothing after it but a comment.
fn bare_key(t: &str) -> Option<&str> {
    let (k, rest) = t.split_once(':')?;
    let rest = rest.trim();
    (rest.is_empty() || rest.starts_with('#')).then(|| k.trim())
}

/// `"x"` or `'x'` as `x`.
fn unquote(v: &str) -> &str {
    let quoted = |q| v.strip_prefix(q).and_then(|r: &str| r.strip_suffix(q));
    quoted('"').or_else(|| quoted('\'')).unwrap_or(v)
}

/// The jobs of the workflow `text`, in their order.
#[must_use]
pub fn jobs(text: &str) -> Vec<Job> {
    let lines: Vec<&str> = text.lines().collect();
    let Some(start) = lines
        .iter()
        .position(|l| indent(l) == 0 && bare_key(l.trim()) == Some("jobs"))
    else {
        return Vec::new();
    };
    let body: Vec<&str> = lines
        .iter()
        .skip(start + 1)
        .take_while(|l| !meaningful(l) || indent(l) > 0)
        .copied()
        .collect();
    let Some(at) = body.iter().find(|l| meaningful(l)).map(|l| indent(l)) else {
        return Vec::new();
    };
    let mut out: Vec<(String, Vec<&str>)> = Vec::new();
    for l in body {
        match (indent(l) == at && meaningful(l), out.last_mut()) {
            (true, _) => out.push((bare_key(l.trim()).unwrap_or("").to_owned(), Vec::new())),
            (false, Some((_, lines))) => lines.push(l),
            (false, None) => {}
        }
    }
    out.into_iter()
        .filter(|(id, _)| !id.is_empty())
        .map(|(id, lines)| job(id, &lines))
        .collect()
}

/// A job from the lines of its body.
fn job(id: String, lines: &[&str]) -> Job {
    let at = lines
        .iter()
        .find(|l| meaningful(l))
        .map_or(0, |l| indent(l));
    let name = lines
        .iter()
        .filter(|l| indent(l) == at)
        .find_map(|l| l.trim().strip_prefix("name:"))
        .map(|v| unquote(v.split(" #").next().unwrap_or(v).trim()).to_owned());
    let matrix = lines.iter().any(|l| step_key(l).1.starts_with("matrix:"));
    Job {
        id,
        name,
        matrix,
        runs: runs(lines),
        uses: local_uses(lines),
    }
}

/// Each local path the `uses:` keys among `lines` name (`./…`), without `./` or a trailing `/`.
fn local_uses(lines: &[&str]) -> Vec<String> {
    lines
        .iter()
        .filter_map(|l| step_key(l).1.strip_prefix("uses:"))
        .map(|v| unquote(v.split(" #").next().unwrap_or(v).trim()))
        .filter_map(|v| v.strip_prefix("./"))
        .map(|v| v.trim_end_matches('/').to_owned())
        .collect()
}

/// A line's column where its key starts, past a list item's `- `, and the text from there.
fn step_key(l: &str) -> (usize, &str) {
    let t = l.trim_start();
    let rest = t.strip_prefix("- ").map_or(t, str::trim_start);
    (l.len() - rest.len(), rest)
}

/// Each command line of the `run:` keys among `lines`: an inline value as one line, a literal
/// block (`|`) line by line with its `\` continuations joined, a folded one (`>`) as one line; an
/// empty value (`defaults: run:`, a mapping) is none.
fn runs(lines: &[&str]) -> Vec<String> {
    let mut out = Vec::new();
    for (i, l) in lines.iter().enumerate() {
        let (col, rest) = step_key(l);
        let Some(value) = rest.strip_prefix("run:").map(str::trim) else {
            continue;
        };
        if value.is_empty() {
            continue;
        }
        if !value.starts_with(['|', '>']) {
            out.push(unquote(value).to_owned());
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
