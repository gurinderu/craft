//! What one profile's gate gathers as its tools run: the checks' outcomes, the tools missing, the
//! notes, and the seed findings, each a finding as `finding-item.schema.json` shapes it with its
//! tool as `source` and the tool's own rule as `toolRule`.

use std::path::Path;

use serde_json::{Value, json};

use super::lines::Lines;
use super::runner::{Ran, Runner};
use super::{Status, Track};

/// What a profile's tools run over.
pub(super) struct Cx<'a> {
    pub runner: &'a Runner,
    /// The working tree's top level, where every path is relative to.
    pub top: &'a Path,
    /// The changed files the profile takes.
    pub files: &'a [String],
    pub lines: &'a Lines,
    pub profile: &'a str,
}

impl Cx<'_> {
    /// The changed file a tool's path names: the same path, or one ending in it (a tool reporting
    /// from a workspace below the top level), or the same absolute path; `None` for another file.
    pub(super) fn changed(&self, path: &str) -> Option<&str> {
        let top = self.top.display().to_string();
        let rel = path
            .strip_prefix(&top)
            .map_or(path, |p| p.trim_start_matches('/'));
        let rel = rel.strip_prefix("./").unwrap_or(rel);
        self.files
            .iter()
            .find(|f| *f == rel || f.ends_with(&format!("/{rel}")))
            .map(String::as_str)
    }

    /// The changed files of this profile that end in `suffix` and are still on disk.
    pub(super) fn present(&self, suffix: &str) -> Vec<&str> {
        self.files
            .iter()
            .filter(|f| f.ends_with(suffix) && self.top.join(f).is_file())
            .map(String::as_str)
            .collect()
    }
}

/// One seed finding a tool reported.
pub(super) struct Seed<'a> {
    pub tool: &'a str,
    pub rule: &'a str,
    pub severity: &'a str,
    /// The tool's own message, verbatim.
    pub title: &'a str,
    pub file: &'a str,
    pub line: u32,
    pub rule_id: &'a str,
}

/// What a profile's gate gathered.
#[derive(Debug, Default)]
pub(super) struct Acc {
    /// The primary check's outcome; `Unknown` until one ran.
    pub status: Option<Status>,
    pub parts: Vec<String>,
    pub failed: Vec<String>,
    pub missing: Vec<String>,
    pub notes: Vec<String>,
    pub seeds: Vec<Value>,
}

impl Acc {
    /// Folds one primary check's outcome in: any fail fails it, any unknown leaves it unknown
    /// unless it failed, and it passes only when every one passed.
    pub(super) fn check(&mut self, s: Status) {
        self.status = Some(match (self.status, s) {
            (Some(Status::Fail), _) | (_, Status::Fail) => Status::Fail,
            (Some(Status::Unknown), _) | (_, Status::Unknown) => Status::Unknown,
            (Some(Status::Pass) | None, Status::Pass) => Status::Pass,
        });
    }

    /// The output of a tool that exited, or `None` with what came of it noted under `label`.
    pub(super) fn exited(&mut self, label: &str, tool: &str, ran: Ran) -> Option<(bool, String, String)> {
        match ran {
            Ran::Exited { ok, out, err } => return Some((ok, out, err)),
            Ran::Missing => self.missing(label, tool),
            Ran::TimedOut(d) => {
                self.parts.push(format!("{label}: timed out"));
                self.notes.push(format!("{label} hit the gate's time budget after {}s — its signal is unknown, not a failure", d.as_secs()));
            }
            Ran::Broken(e) => {
                self.parts.push(format!("{label}: could not run"));
                self.notes.push(format!("{label} could not run: {e}"));
            }
        }
        None
    }

    /// Names `tool` as not installed: `label` skipped, never a failure.
    pub(super) fn missing(&mut self, label: &str, tool: &str) {
        self.parts.push(format!("{label}: not installed"));
        if !self.missing.iter().any(|m| m == tool) {
            self.missing.push(tool.to_owned());
        }
    }

    /// Adds a seed unless one of the same tool rule, or the same title where none is named, is
    /// already at its place.
    pub(super) fn seed(&mut self, cx: &Cx<'_>, s: &Seed<'_>) {
        let at = |f: &Value, k: &str| f.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
        let same = self.seeds.iter().any(|f| {
            at(f, "file") == s.file
                && f.get("line") == Some(&json!(s.line))
                && (at(f, "toolRule") == s.rule && (!s.rule.is_empty() || at(f, "title") == s.title))
        });
        if same {
            return;
        }
        let rule = if s.rule.is_empty() { String::new() } else { format!(" ({})", s.rule) };
        let mut f = json!({
            "severity": s.severity, "title": s.title, "file": s.file, "line": s.line,
            "why": format!("{} reports it{rule} on a line this change added or rewrote: the tool's own diagnostic, seeded by the gate.", s.tool),
            "fix": "", "blastRadius": "", "source": s.tool, "ruleId": s.rule_id, "whereChecked": "",
            "profile": cx.profile, "foundInRound": 0,
        });
        if let (false, Some(o)) = (s.rule.is_empty(), f.as_object_mut()) {
            o.insert("toolRule".into(), json!(s.rule));
        }
        self.seeds.push(f);
    }

    /// The track it came to and its seeds.
    pub(super) fn into_track(self, profile: &str) -> (Track, Vec<Value>) {
        let track = Track {
            profile: profile.to_owned(),
            status: self.status.unwrap_or_default(),
            provenance: self.parts.join(" · "),
            failed_checks: self.failed,
            missing: self.missing,
            notes: self.notes,
            seeds: self.seeds.len(),
        };
        (track, self.seeds)
    }
}

/// The last non-empty line of a tool's stderr, cut to one line of a note.
pub(super) fn last_line(err: &str) -> String {
    let line = err.lines().map(str::trim).rfind(|l| !l.is_empty());
    line.unwrap_or("no message").chars().take(200).collect()
}
