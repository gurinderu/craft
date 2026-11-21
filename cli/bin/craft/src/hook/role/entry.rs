//! The hooks' trace (realm @nick/craft, nodes #281, #283): one JSON line per run in
//! `~/.craft/hooks.jsonl` — the event, whether it spoke, on what, or why it stayed silent — which
//! `lib/analyze-runs.mjs` reads back, and the prompt hook reads for what a session already heard.
//! Writing never fails the session (#276); the file is bounded by rotation to one older
//! generation. The fields keep the order the Node hooks wrote them in.

use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

const MAX_BYTES: u64 = 256 * 1024;

/// One line of the log. `kind` is the prompt class, `agent` the subagent type, `readiness` the
/// readiness lines a Codex start said, `reason` what a line that spoke said when it was not a
/// request's text — or, on a prompt's silent line, `no-work-sign`, and on every line of the
/// Agent-tool hook, `reviewer-dispatch`. The fields keep the order each Node hook wrote them in.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Entry {
    pub ts: String,
    pub repo: String,
    pub source: String,
    pub event: String,
    pub harness: String,
    pub session: String,
    pub spoke: bool,
    pub found: Vec<String>,
    pub silent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// `kind` where a line names it after its agent: an OpenCode subagent's line.
    #[serde(rename = "kind", skip_serializing_if = "Option::is_none")]
    pub agent_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub readiness: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Whether a reviewer dispatch the Agent-tool hook spoke on, or kept silent on as already said,
    /// runs in the background.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<bool>,
}

impl Entry {
    /// The line silent for `why`.
    pub fn quiet(mut self, why: &str) -> Self {
        self.spoke = false;
        self.silent = Some(why.to_owned());
        self
    }

    pub fn because(mut self, reason: &str) -> Self {
        self.reason = Some(reason.to_owned());
        self
    }
}

/// `~/.craft/hooks.jsonl` under `home`.
pub fn log_path(home: &Path) -> PathBuf {
    home.join(".craft").join("hooks.jsonl")
}

fn older(file: &Path) -> PathBuf {
    let mut name = file.as_os_str().to_owned();
    name.push(".1");
    PathBuf::from(name)
}

/// Append one entry; past `MAX_BYTES` the file becomes `<file>.1` first. Every error is
/// swallowed: a lost line is better than a failed session.
pub fn append(entry: &Entry, file: &Path) {
    let write = || -> std::io::Result<()> {
        if let Some(dir) = file.parent() {
            fs::create_dir_all(dir)?;
        }
        if fs::metadata(file).is_ok_and(|m| m.len() > MAX_BYTES) {
            fs::rename(file, older(file))?;
        }
        let line = serde_json::to_string(entry).map_err(std::io::Error::other)?;
        let mut f = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(file)?;
        f.write_all(format!("{line}\n").as_bytes())
    };
    write().unwrap_or_default();
}

/// Both generations, oldest first; a line that does not parse, or lacks a string `repo` and a
/// boolean `spoke`, is skipped. `None` when neither file is there.
pub fn read(file: &Path) -> Option<Vec<Value>> {
    let mut any = false;
    let mut out = Vec::new();
    for f in [older(file), file.to_path_buf()] {
        let Ok(bytes) = fs::read(&f) else { continue };
        any = true;
        for line in String::from_utf8_lossy(&bytes).split('\n') {
            if let Ok(v) = serde_json::from_str::<Value>(line)
                && v.get("repo").is_some_and(Value::is_string)
                && v.get("spoke").is_some_and(Value::is_boolean)
            {
                out.push(v);
            }
        }
    }
    any.then_some(out)
}

/// A string field of a log line.
pub fn field<'a>(e: &'a Value, key: &str) -> Option<&'a str> {
    e.get(key).and_then(Value::as_str)
}

/// Whether a log line has `key` at all (JS's `!== undefined`).
pub fn has(e: &Value, key: &str) -> bool {
    e.get(key).is_some()
}

/// The event a line belongs to; a line from before the field is `SessionStart`'s.
pub fn event(e: &Value) -> &str {
    field(e, "event")
        .filter(|s| !s.is_empty())
        .unwrap_or("SessionStart")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(repo: &str) -> Entry {
        Entry {
            ts: "2026-10-30T12:00:00.000Z".to_owned(),
            repo: repo.to_owned(),
            source: String::new(),
            event: "UserPromptSubmit".to_owned(),
            harness: "claude-code".to_owned(),
            session: "s".to_owned(),
            spoke: true,
            found: Vec::new(),
            silent: None,
            kind: None,
            agent: None,
            agent_kind: None,
            readiness: None,
            reason: None,
            background: None,
        }
    }

    #[test]
    fn past_its_cap_the_log_rotates_to_one_older_generation_read_first() {
        let d = tempfile::tempdir().unwrap();
        let file = log_path(d.path());
        append(&line("/old"), &file);
        fs::write(
            &file,
            format!(
                "{}\n{}\n",
                serde_json::to_string(&line("/old")).unwrap(),
                "x".repeat(300 * 1024)
            ),
        )
        .unwrap();
        append(&line("/new"), &file);
        assert!(fs::metadata(&file).unwrap().len() < 1024);
        let repos: Vec<String> = read(&file)
            .unwrap()
            .iter()
            .map(|e| e["repo"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(repos, ["/old", "/new"]);
    }

    #[test]
    fn appending_never_fails_even_where_the_log_cannot_be_made() {
        let d = tempfile::tempdir().unwrap();
        let blocker = d.path().join("file");
        fs::write(&blocker, "").unwrap();
        append(&line("/r"), &log_path(&blocker));
        assert_eq!(read(&log_path(&blocker)), None);
    }
}
