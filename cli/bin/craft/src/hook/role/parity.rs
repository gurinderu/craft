//! The hooks held to the Node hooks they replace by `content/parity/hook-cases.json`, frozen
//! golden data the Node hooks computed before the port: the same repo, environment, hook log and
//! input give the same stdout, byte for byte, and the same log line; a case a later decision
//! changed is edited by hand (the reminder and the reviewer-dispatch lines said less often: #288).
//! Its `kinds` hold the prompt classes, which `lib/work-hook-kind.mjs` still computes for OpenCode
//! and `lib/hook-cases-parity.test.mjs` holds to the same file.

use std::collections::HashMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use serde_json::Value;

use super::kind::{Kind, prompt_kind};
use super::readiness::{Probe, Probed};
use super::{Ctx, Hook, Run, dispatch, entry, iso, opencode, start, work};

const CASES: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../content/parity/hook-cases.json"
));

struct Fake(Value);

impl Probe for Fake {
    fn sandbox(&self) -> Option<Probed> {
        match &self.0 {
            Value::Null => Some(Probed {
                status: Some(0),
                stderr: String::new(),
            }),
            Value::String(_) => None,
            p @ (Value::Bool(_) | Value::Number(_) | Value::Array(_) | Value::Object(_)) => {
                Some(Probed {
                    status: p["status"].as_i64().and_then(|s| i32::try_from(s).ok()),
                    stderr: p["stderr"].as_str().unwrap_or("").to_owned(),
                })
            }
        }
    }
}

struct Places {
    _dirs: [tempfile::TempDir; 3],
    swap: Vec<(&'static str, String)>,
}

impl Places {
    fn new() -> Self {
        let dirs = [(); 3].map(|()| tempfile::tempdir().unwrap());
        let real =
            |d: &tempfile::TempDir| fs::canonicalize(d.path()).unwrap().display().to_string();
        let swap = vec![
            ("<root>", real(&dirs[0])),
            ("<home>", real(&dirs[1])),
            ("<plugin>", real(&dirs[2])),
        ];
        Self { _dirs: dirs, swap }
    }

    fn at(&self, i: usize) -> &Path {
        Path::new(&self.swap[i].1)
    }

    fn fill(&self, s: &str) -> String {
        self.swap
            .iter()
            .fold(s.to_owned(), |s, (k, v)| s.replace(k, v))
    }

    fn fill_value(&self, v: &Value) -> Value {
        match v {
            Value::String(s) => Value::String(self.fill(s)),
            Value::Array(a) => Value::Array(a.iter().map(|x| self.fill_value(x)).collect()),
            Value::Object(m) => Value::Object(
                m.iter()
                    .map(|(k, x)| (k.clone(), self.fill_value(x)))
                    .collect(),
            ),
            other @ (Value::Null | Value::Bool(_) | Value::Number(_)) => other.clone(),
        }
    }
}

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

/// The case's repo, plugin root, binary cache and hook log, laid out as the Node run had them.
fn lay_out(c: &Value, p: &Places) {
    let (root, home, plugin) = (p.at(0), p.at(1), p.at(2));
    if c["git"] != Value::Bool(false) {
        fs::create_dir(root.join(".git")).unwrap();
    }
    for (rel, text) in c["files"].as_object().into_iter().flatten() {
        write(&root.join(rel), text.as_str().unwrap());
    }
    for (rel, target) in c["links"].as_object().into_iter().flatten() {
        std::os::unix::fs::symlink(p.fill(target.as_str().unwrap()), root.join(rel)).unwrap();
    }
    for d in c["dirs"].as_array().into_iter().flatten() {
        fs::create_dir_all(root.join(d.as_str().unwrap())).unwrap();
    }
    if let Some(v) = c["pluginVersion"].as_str() {
        write(
            &plugin.join(".codex-plugin/plugin.json"),
            &serde_json::json!({ "version": v }).to_string(),
        );
    }
    for v in c["cachedBins"].as_array().into_iter().flatten() {
        let bin = home
            .join(".craft/bin")
            .join(v.as_str().unwrap())
            .join("craft");
        write(&bin, "#!/bin/sh\n");
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
    }
    if let Some(lines) = c["log"].as_array() {
        let text: Vec<String> = lines
            .iter()
            .map(|l| {
                l.as_str()
                    .map_or_else(|| p.fill_value(l).to_string(), str::to_owned)
            })
            .collect();
        write(&entry::log_path(home), &format!("{}\n", text.join("\n")));
    }
}

fn hook_of(command: &str) -> Hook {
    match command {
        "session-start" => Hook::SessionStart,
        "user-prompt" => Hook::UserPrompt,
        "subagent-start" => Hook::SubagentStart,
        "reviewer-dispatch" => Hook::ReviewerDispatch,
        "opencode-message" => Hook::OpencodeMessage,
        "opencode-compacted" => Hook::OpencodeCompacted,
        other => panic!("no hook {other}"),
    }
}

fn run_case(c: &Value, p: &Places) -> Run {
    let env: HashMap<String, String> = c["env"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(k, v)| (k.clone(), p.fill(v.as_str().unwrap())))
        .collect();
    let input = match &c["input"] {
        Value::String(s) => p.fill(s),
        v @ (Value::Null
        | Value::Bool(_)
        | Value::Number(_)
        | Value::Array(_)
        | Value::Object(_)) => p.fill_value(v).to_string(),
    };
    let ctx = Ctx {
        env,
        home: Some(p.at(1).to_path_buf()),
        fallback_cwd: p.at(0).join(c["cwd"].as_str().unwrap_or("")),
        now: iso::parse(c["now"].as_str().unwrap_or("2026-10-30T12:00:00.000Z")).unwrap(),
    };
    match hook_of(c["command"].as_str().unwrap()) {
        Hook::SessionStart => start::run(&input, &ctx, &Fake(c["probe"].clone())),
        Hook::UserPrompt => work::prompt(&input, &ctx),
        Hook::SubagentStart => work::subagent(&input, &ctx),
        Hook::ReviewerDispatch => dispatch::run(&input, &ctx),
        Hook::OpencodeMessage => opencode::message(&input, &ctx),
        Hook::OpencodeCompacted => opencode::compacted(&input, &ctx),
    }
}

#[test]
fn every_hook_case_gives_the_node_hooks_stdout_and_log_line() {
    let file: Value = serde_json::from_str(CASES).unwrap();
    let cases: Vec<&Value> = ["cases", "opencode"]
        .iter()
        .flat_map(|k| file[k].as_array().unwrap())
        .collect();
    assert!(cases.len() >= 120, "{} cases", cases.len());
    let mut failed = Vec::new();
    for c in cases {
        let name = c["name"].as_str().unwrap();
        let p = Places::new();
        lay_out(c, &p);
        let run = run_case(c, &p);
        let want = p.fill(c["stdout"].as_str().unwrap());
        if run.stdout != want {
            failed.push(format!(
                "{name}: stdout\n  got:  {}\n  want: {want}",
                run.stdout
            ));
        }
        let line = run.entry.map(|e| serde_json::to_string(&e).unwrap());
        let want = c["entryLine"].as_str().map(|l| p.fill(l));
        if line != want {
            failed.push(format!(
                "{name}: log line\n  got:  {line:?}\n  want: {want:?}"
            ));
        }
    }
    assert!(
        failed.is_empty(),
        "{} failed:\n{}",
        failed.len(),
        failed.join("\n")
    );
}

#[test]
fn every_prompt_takes_the_class_the_node_hook_gave_it() {
    let file: Value = serde_json::from_str(CASES).unwrap();
    let mut failed = Vec::new();
    for k in file["kinds"].as_array().unwrap() {
        let prompt = k["prompt"].as_str().unwrap();
        let recent = k["recent"].as_str().and_then(Kind::from_name);
        let got = prompt_kind(prompt, recent).map(Kind::name);
        if got != k["kind"].as_str() {
            failed.push(format!(
                "{prompt:?} (recent {recent:?}): got {got:?}, want {}",
                k["kind"]
            ));
        }
    }
    assert!(
        failed.is_empty(),
        "{} failed:\n{}",
        failed.len(),
        failed.join("\n")
    );
}
