#![expect(
    clippy::unwrap_used,
    reason = "fixture failures must fail the owning test"
)]
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

pub struct Bench(tempfile::TempDir);

pub fn read(path: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

impl Bench {
    pub fn new() -> Self {
        let b = Self(tempfile::tempdir().unwrap());
        for dir in ["home", "repo", "caller"] {
            std::fs::create_dir_all(b.path(dir)).unwrap();
        }
        std::fs::write(b.path("report.md"), "No findings.").unwrap();
        std::fs::write(b.path("host.mjs"), HOST).unwrap();
        crate::common::write_executable(
            &b.path("host"),
            "#!/bin/sh\nexec node \"$FIXTURE/host.mjs\" \"$@\"\n",
        )
        .unwrap();
        b
    }

    pub fn path(&self, p: &str) -> PathBuf {
        self.0.path().join(p)
    }

    pub fn command(&self, backend: &str, mode: &str) -> Command {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .unwrap();
        let mut c = Command::new(env!("CARGO_BIN_EXE_craft"));
        c.args([
            "triage",
            "run",
            "--backend",
            backend,
            "--events",
            "json",
            "--concurrency",
            "1",
        ])
        .arg("--host-bin")
        .arg(self.path("host"))
        .arg("--craft-root")
        .arg(root)
        .env("HOME", self.path("home"))
        .env("USERPROFILE", self.path("home"))
        .env("FIXTURE", self.0.path())
        .env("MODE", mode)
        .env_remove("CRAFT_RUNS_DIR")
        .env_remove("CRAFT_ROOT")
        .current_dir(self.path("caller"));
        c
    }

    pub fn start(&self, backend: &str, mode: &str) -> Output {
        self.command(backend, mode)
            .arg("--repo")
            .arg(self.path("repo"))
            .arg("--report")
            .arg(self.path("report.md"))
            .arg("--run-dir")
            .arg(self.path("run"))
            .output()
            .unwrap()
    }

    pub fn resume(&self, backend: &str, mode: &str) -> Output {
        self.command(backend, mode)
            .arg("--run")
            .arg(self.path("run"))
            .output()
            .unwrap()
    }

    pub fn expect(&self, out: &Output, code: i32) {
        assert_eq!(
            out.status.code(),
            Some(code),
            "fixture={}\nstdout={}\nstderr={}",
            self.0.path().display(),
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
    }

    pub fn result(&self, out: &Output) -> Value {
        let result = String::from_utf8_lossy(&out.stderr)
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .rfind(|v| v["type"] == "triage_result")
            .unwrap();
        assert_eq!(
            result.get("run"),
            Some(&serde_json::json!(self.path("run")))
        );
        result
    }

    pub fn calls(&self) -> Vec<Value> {
        std::fs::read_to_string(self.path("calls"))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    pub fn index(&self) -> Vec<String> {
        std::fs::read_to_string(self.path("home/.craft/runs/index.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }
}

const HOST: &str = r#"
import fs from 'node:fs';
const args = process.argv.slice(2);
const at = process.env.FIXTURE;
const mode = process.env.MODE;
fs.appendFileSync(at + '/calls', JSON.stringify({cwd: process.cwd(), args}) + '\n');
if (args[0] === '--version') { console.log('opencode v2.2.7'); process.exit(0); }
if (args[0] === 'debug') { console.log('[{"id":"review-task"}]'); process.exit(0); }
if (args[0] === 'agent' && args[1] === 'list') { console.log('review-task (primary)'); process.exit(0); }
if (args[0] === 'run' && args[1] === '--help') { console.log('--agent --format --title --model --variant'); process.exit(0); }
if (mode === 'limit') { console.error("You've hit your usage limit. Try again in 3 hours."); process.exit(1); }
const codex = args.includes('exec');
const opencode = args[0] === 'run';
const output = codex ? args[args.indexOf('-o') + 1] : '';
const message = codex || opencode ? fs.readFileSync(0, 'utf8') : args.at(-1);
const prompt = codex ? message : fs.readFileSync(/^Read the file (.+?) and do/s.exec(message)[1], 'utf8');
const state = JSON.parse(fs.readFileSync(at + '/run/state.json', 'utf8'));
const task = state.tasks.find(t => t.state === 'pending');
const plan = task.kind === 'plan';
if ((mode === 'missing' && !plan) || (mode === 'plan-fails' && plan)) process.exit(1);
let value = {source: 'review', findings: []};
const full = mode === 'nonempty' || mode === 'unjudged';
if (task.kind === 'gatherReport') {
  if (!prompt.includes(state.args.report)) throw new Error('report path missing from prompt');
  if (!fs.readFileSync(state.args.report, 'utf8').includes('No findings.')) throw new Error('report is unreadable');
}
if (full && task.kind.startsWith('gather')) {
  const pr = task.kind === 'gatherPr';
  value = {source: pr ? 'github-pr' : 'review', findings: [{severity: 'Medium', title: 'test finding', location: 'src/a.rs:1', detail: 'wrong condition', proposed_fix: 'invert condition', thread_id: pr ? 'thread-17' : ''}]};
} else if (task.kind === 'recall') value = {backend: 'none', why: 'pinned backend unavailable: mcp test store; host has no MCP', decisions: [], queryError: 'MCP unavailable'};
else if (task.kind === 'validate') {
  if (mode === 'unjudged') process.exit(1);
  value = {stable_id: task.finding, verdict: 'accept', reason: 'observed condition', fix_pointer: 'fix condition', premise_checked: state.args.pr ? 'git show main:src/a.rs' : 'src/a.rs:1', noise_class: state.args.pr ? 1 : 0, severity: 'Medium'};
} else if (plan) value = {plan_markdown: 'BODY', summary: 'SUM', ledger: state.tasks.filter(t => t.kind === 'validate').map(t => ({stable_id: t.finding, verdict: 'accept', reason: 'observed condition'}))};
const answer = mode === 'malformed' && !plan ? '{bad'
  : JSON.stringify(value);
if (codex) fs.writeFileSync(output, answer);
else if (opencode) console.log(JSON.stringify({type: 'text', part: {id: 'p', text: '```craft-answer\n' + answer + '\n```'}}));
else console.log('```craft-answer\n' + answer + '\n```');
"#;
