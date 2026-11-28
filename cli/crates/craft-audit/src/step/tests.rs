//! The audit's steps end to end over a scratch repository, a host's answers written into the
//! answer files and the store's writer faked.

mod budget;
mod ending;
mod halt;
mod lifecycle;
mod refile;
mod unjudged;

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::process::Command;

use craft_review::filing::{Call, WriteError, Writer};
use serde_json::{Value, json};

use super::{Said, StartOptions, start, submit};
use crate::state::{Args, Recording};

/// A store writer that keeps each request and answers as told.
#[derive(Default)]
pub(super) struct Fake {
    pub calls: RefCell<Vec<Value>>,
    pub refuse: RefCell<bool>,
}

impl Writer for Fake {
    fn write(&self, call: &Call<'_>) -> Result<Value, WriteError> {
        let kept = super::filing::read(call.run).map(|f| f.record);
        let mut request = call.request.clone();
        request["keptAtWrite"] = json!(kept);
        let written = [super::report_path(call.run), super::record_path(call.run)];
        request["writtenAtWrite"] = json!(written.iter().all(|p| p.is_file()));
        self.calls.borrow_mut().push(request);
        if *self.refuse.borrow() {
            return Ok(json!({"ok": false, "reason": "the store is read-only", "file": ""}));
        }
        Ok(json!({"ok": true, "reason": "", "file": "/store/audit.json"}))
    }
}

pub(super) struct Scratch {
    _dir: tempfile::TempDir,
    pub repo: PathBuf,
    pub run: PathBuf,
}

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// A repository tracking `files`, each `bytes` long.
pub(super) fn scratch(files: &[&str]) -> Scratch {
    let d = tempfile::tempdir().unwrap();
    let repo = d.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q"]);
    for f in files {
        let at = repo.join(f);
        std::fs::create_dir_all(at.parent().unwrap()).unwrap();
        std::fs::write(at, "x = 1\n").unwrap();
    }
    git(&repo, &["add", "-A"]);
    let run = d.path().join("run");
    Scratch { _dir: d, repo, run }
}

pub(super) fn args(lens_agents: Option<usize>) -> Args {
    Args {
        batch_bytes: 10,
        lens_agents,
        craft_version: "9.9.9".into(),
        record: Some(Recording::default()),
        ..Args::default()
    }
}

pub(super) fn open(s: &Scratch, args: Args, w: &Fake) -> Value {
    let opts = StartOptions {
        cwd: s.repo.clone(),
        run_dir: s.run.clone(),
        args,
    };
    start(&opts, w).unwrap()
}

pub(super) fn ids(step: &Value) -> Vec<String> {
    step["tasks"]
        .as_array()
        .map(|t| {
            t.iter()
                .map(|t| t["id"].as_str().unwrap().to_owned())
                .collect()
        })
        .unwrap_or_default()
}

/// Writes `answer` as task `id`'s answer file.
pub(super) fn answer(run: &Path, id: &str, answer: &Value) {
    std::fs::write(
        run.join("answers").join(format!("{id}.json")),
        answer.to_string(),
    )
    .unwrap();
}

/// A lens's answer with `findings`.
pub(super) fn found(findings: &[Value]) -> Value {
    json!({"lens": "l", "findings": findings})
}

pub(super) fn finding(sev: &str, file: &str) -> Value {
    json!({"severity": sev, "title": format!("{sev} in {file}"), "file": file, "line": 1, "why": "w",
        "fix": "f", "blastRadius": "", "source": "", "ruleId": "", "whereChecked": "", "harmLevel": "outage", "harm": "h"})
}

/// Every pending task of `step` answered with no finding.
pub(super) fn clean(run: &Path, step: &Value) {
    for id in ids(step) {
        answer(run, &id, &found(&[]));
    }
}

pub(super) fn next(run: &Path, w: &Fake, said: &Said<'_>) -> Value {
    submit(run, None, said, w).unwrap()
}
