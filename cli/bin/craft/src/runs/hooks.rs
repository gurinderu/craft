//! `craft runs hooks`: craft's hooks' trace (`~/.craft/hooks.jsonl` and its older generation;
//! realm @nick/craft, nodes #281, #283, #550) beside the runs it may have shaped — per event (and per
//! harness, when more than one wrote the log), its firings against its silences by reason, a line
//! with a `reason` its own row; and how many workflow runs the filters keep came from a repository
//! after the start hook first spoke there. A line that does not read is passed over and counted.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::Path;

use anyhow::{Context, Result};
use craft_store::filter::Filter;
use craft_store::js::Js;
use craft_store::read::{self, Skipped};

mod log;
mod render;

pub(super) use log::millis;
use log::{Line, read};

/// One row: its event (with reason and harness), runs, spoke, and the silences by reason.
pub(super) struct Row {
    pub group: String,
    pub runs: u64,
    pub spoke: u64,
    pub silent: Vec<(String, u64)>,
}

/// The rows, the start hook's rows first, the rest by UTF-16 code units.
fn rows(lines: &[Line]) -> Vec<Row> {
    let several = lines
        .iter()
        .map(|l| &l.harness)
        .collect::<BTreeSet<_>>()
        .len()
        > 1;
    let group = |l: &Line| {
        let reason = if l.reason.is_empty() {
            String::new()
        } else {
            format!(" {}", l.reason)
        };
        let harness = if several {
            format!(" ({})", l.harness)
        } else {
            String::new()
        };
        format!("{}{reason}{harness}", l.event)
    };
    let mut groups: Vec<String> = lines
        .iter()
        .map(group)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    groups.sort_by(|a, b| {
        b.starts_with("SessionStart")
            .cmp(&a.starts_with("SessionStart"))
            .then_with(|| a.encode_utf16().cmp(b.encode_utf16()))
    });
    groups
        .into_iter()
        .map(|g| {
            let mine: Vec<&Line> = lines.iter().filter(|l| group(l) == g).collect();
            let mut silent: Vec<(String, u64)> = Vec::new();
            for l in mine.iter().filter(|l| !l.spoke) {
                match silent.iter_mut().find(|(r, _)| *r == l.silent) {
                    Some(at) => at.1 += 1,
                    None => silent.push((l.silent.clone(), 1)),
                }
            }
            silent.sort_by_key(|s| std::cmp::Reverse(s.1));
            Row {
                group: g,
                runs: mine.len() as u64,
                spoke: mine.iter().filter(|l| l.spoke).count() as u64,
                silent,
            }
        })
        .collect()
}

/// Per repository, when the start hook's role text first spoke there.
fn first_spoke(lines: &[Line]) -> BTreeMap<String, i64> {
    let mut first = BTreeMap::new();
    for l in lines
        .iter()
        .filter(|l| l.event == "SessionStart" && l.reason.is_empty() && l.spoke)
    {
        if let Some(t) = l.ts {
            let at = first.entry(l.repo.clone()).or_insert(t);
            *at = (*at).min(t);
        }
    }
    first
}

/// The hooks' report over the log at `log`, else `~/.craft/hooks.jsonl`, joined to the runs `filter` keeps.
pub(super) fn report(
    out: &mut dyn Write,
    store: &Path,
    filter: &Filter,
    log: Option<&Path>,
    json: bool,
    skipped: &mut Skipped,
) -> Result<()> {
    let log = match log {
        Some(l) => l.to_path_buf(),
        None => read::home_store()
            .and_then(|s| s.parent().map(|c| c.join("hooks.jsonl")))
            .context("no home names ~/.craft/hooks.jsonl; pass --log")?,
    };
    let Some((lines, bad)) = read(&log) else {
        writeln!(
            out,
            "no hook log at {}: no craft hook has run here",
            log.display()
        )?;
        return Ok(());
    };
    if bad > 0 {
        let mut err = std::io::stderr().lock();
        drop(writeln!(
            err,
            "craft runs: passed over {bad} line(s) of {} that are not a hook's line",
            log.display()
        ));
    }
    let first = first_spoke(&lines);
    let (mut joined, mut runs) = (0, 0);
    super::visit::walk(store, &|r| filter.keeps(r), skipped, &mut |seen| {
        if let super::visit::Seen::Standing(_, r) = seen
            && r.text_units("kind") == "workflow"
        {
            runs += 1;
            let since = r
                .get("project")
                .and_then(Js::as_str)
                .and_then(|p| first.get(p));
            let at = r.get("ts").and_then(Js::as_str).and_then(millis);
            joined += u64::from(since.zip(at).is_some_and(|(s, a)| a >= *s));
        }
        Ok(())
    })?;
    render::render(out, &rows(&lines), (joined, runs, first.len()), json)?;
    Ok(())
}
