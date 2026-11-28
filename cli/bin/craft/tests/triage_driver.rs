//! The JavaScript driver's actual commands through the freshly built CLI, with real task files
//! and an isolated run store (realm @nick/craft, node #616). Node and Bash are CI prerequisites.

use std::path::Path;
use std::process::Command;

const PROTOCOL: &str = r"
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
const load = name => import(pathToFileURL(path.join(process.env.ROOT, 'integrations/shared', name)));
const {triageStart} = await load('cli-triage-commands.mjs');
// The submit and status the driver itself runs: every kind's, made for the triage (cli-step-driver.mjs).
const {stepCommands} = await load('cli-step-commands.mjs');
const {submit: triageSubmit, status: triageStatus} = stepCommands('triage');
const {readTriageOptions} = await load('cli-triage-options.mjs');
const {shq} = await load('plugin-script.mjs');
const bin = shq(process.env.CRAFT_BIN);
const run = path.join(process.env.HOME, 'run');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const execute = command => spawnSync('bash', ['-c', command], {encoding: 'utf8'});
const ok = command => {
  const out = execute(command);
  assert.equal(out.status, 0, command + '\n' + out.stderr);
  return JSON.parse(out.stdout);
};
const submit = said => ok(triageSubmit(bin, run, said, {agents: 2, tokens: 123}));
const state = () => read(path.join(run, 'state.json'));
const report = path.join(process.env.HOME, 'report.md');
fs.writeFileSync(report, 'No findings.');
const o = readTriageOptions({report, repo: process.env.HOME, priorLedger: [], priorDecisions: []}).options;
let step = ok(triageStart(bin, o, '9.9.9', process.env.ROOT) + ' --run-dir ' + shq(run));
const id = step.tasks[0].id;
submit({resume: true});
assert.equal(state().tasks.find(t => t.id === id).retries, 0);
submit({});
assert.equal(state().tasks.find(t => t.id === id).retries, 1);
const limited = submit({limit: 'weekly limit', degraded: ['fallback agent']});
assert.equal(limited.stopped.text, 'weekly limit');
assert.equal(ok(triageStatus(bin, run)).stopped.text, 'weekly limit');
step = submit({resume: true});
assert.equal(step.done, false);
assert.equal(state().tasks.find(t => t.id === id).retries, 0);
if (process.env.ABANDON === 'yes') {
  step = submit({abandoned: [id]});
  const task = state().tasks.find(t => t.id === id);
  assert.equal(task.state, 'failed');
  assert.equal(task.abandoned, true);
}
// A real storage failure, repaired before resuming the finished run.
const store = path.join(process.env.HOME, '.craft', 'runs');
fs.mkdirSync(path.dirname(store), {recursive: true});
fs.writeFileSync(store, 'not a directory');
const kinds = [];
for (let round = 0; !step.done && round < 8; round++) {
  for (const task of step.tasks) {
    kinds.push(task.kind);
    const answer = task.kind === 'gatherReport' ? {source: 'review', findings: []}
      : task.kind === 'plan' ? {plan_markdown: 'BODY', summary: 'SUM', ledger: []} : null;
    assert.ok(answer, JSON.stringify(task));
    assert.ok(fs.readFileSync(task.promptFile, 'utf8').length);
    assert.ok(read(task.schemaFile).type);
    fs.writeFileSync(task.answerFile, JSON.stringify(answer));
  }
  step = submit({});
}
assert.equal(step.done, true);
assert.ok(step.planFile);
assert.equal(step.filing.record, 'failed');
const before = fs.readFileSync(step.recordFile, 'utf8');
fs.unlinkSync(store);
step = submit({resume: true});
assert.equal(step.filing.record, 'filed');
assert.equal(fs.readFileSync(step.recordFile, 'utf8'), before);
assert.equal(fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8').trim().split('\n').length, 1);
assert.deepEqual(step.degraded, ['fallback agent']);
if (process.env.ABANDON !== 'yes') {
  assert.ok(kinds.includes('plan'), JSON.stringify(kinds));
  assert.ok(read(step.planFile).plan_markdown.endsWith('BODY'));
}
const again = execute(triageSubmit(bin, run, {resume: true}, {agents: 0, tokens: null}));
assert.equal(again.status, 1, again.stderr);
assert.match(again.stderr, /is done/);
assert.equal(ok(triageStatus(bin, run)).done, true);
assert.equal(fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8').trim().split('\n').length, 1);
// The driver sees the real Done exit, asks the real status, and must not launch its logger.
const {runCliTriage} = await load('cli-triage-steps.mjs');
const calls = [];
const reportText = await runCliTriage({
  args: {run, repo: process.env.HOME, craftBin: process.env.CRAFT_BIN, craftRoot: path.join(process.env.ROOT, 'integrations/claude-code')},
  phase() {}, log() {}, parallel: jobs => Promise.all(jobs.map(f => f())),
  agent: async (prompt, opts) => {
    calls.push(opts.label);
    assert.ok(opts.label.startsWith('step:'), 'unexpected agent: ' + opts.label);
    const cmd = /```sh\n([\s\S]*?)```/.exec(prompt)?.[1]
      ?? /\n\n(.+)\n\nReturn \{exitCode/s.exec(prompt)?.[1];
    assert.ok(cmd, prompt);
    const out = execute(cmd);
    return {exitCode: out.status, stdout: out.stdout, stderr: out.stderr};
  },
}, '9.9.9');
assert.ok(calls.includes('step:status'), JSON.stringify(calls) + reportText);
assert.ok(reportText.includes('The plan is ' + step.planFile), reportText);
assert.equal(fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8').trim().split('\n').length, 1);
";

#[test]
fn generated_commands_finish_resume_and_refile_through_the_real_protocol() {
    for abandon in ["no", "yes"] {
        let home = tempfile::tempdir().unwrap();
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .unwrap();
        let out = Command::new("node")
            .args(["--input-type=module", "-e", PROTOCOL])
            .env("ROOT", root)
            .env("CRAFT_BIN", env!("CARGO_BIN_EXE_craft"))
            .env("HOME", home.path())
            .env("ABANDON", abandon)
            .current_dir(home.path())
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{abandon}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
}
