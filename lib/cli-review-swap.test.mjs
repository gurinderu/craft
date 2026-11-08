// What a launcher of the JS review meets in the cli-review driver (lib/cli-review-steps.mjs, lib/cli-review-keys.mjs,
// lib/cli-review-verdict.mjs): the arguments it does not take refused with nothing run, the launch options passed on
// to the binary (`optional`, `_recalled`) and to the record (`_via`), and an answer a parent reads per finding and by
// its stop.
import { afterAll, test } from 'vitest'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runEngine } from './engine-harness.mjs'
import { asLogger } from './logger-replay.mjs'
import { limitInReport } from './limit-report.mjs'
import { reviewResult, verdictLine } from './rust-audit-verdict.mjs'
import { finishedAnswer } from './cli-review-verdict.mjs'

/** @type {string[]} */
const made = []
afterAll(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }) })

/** @param {string} prefix @returns {string} */
function tmp(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  made.push(dir)
  return dir
}

const RUN = '/tmp/run-s'
const FINDINGS = [
  { severity: 'High', file: 'src/lib.rs', line: 3, title: 'f returns 1\nwhere 0 is claimed', ruleId: '', tier: 'confirmed' },
  { severity: 'Low', file: 'src/lib.rs', line: 0, title: 'naming', ruleId: '', tier: 'unverified' },
]
/** The binary's finished step, `over` laid on it. @param {Record<string, unknown>} [over] */
const finished = (over = {}) => ({
  exitCode: 0, stderr: '',
  stdout: JSON.stringify({ run: RUN, done: true, report: `${RUN}/report.md`, verdict: 'Block', line: 'Block — 1 High', findings: FINDINGS, ...over }),
})
const LOGGED = { checkpoint: { runDir: '/store/.partial/run-A', error: '' }, 'log-run': { ok: true, output: ['wrote /store/r.json'] } }

/** A run with `args` whose binary is done at once. @param {Record<string, unknown>} args @param {Record<string, unknown>} [over] */
const runWith = (args, over) => runEngine('cli-review', { args: { craftBin: '/opt/craft', ...args }, script: { 'step:start': finished(over), ...LOGGED } })

/** @type {Array<[string, unknown, RegExp]>} */
const REFUSED = [
  ['languages', ['rust'], /languages= is not taken: each changed file goes to its profile \(Rust, Nix, general\); narrow with path=/],
  ['deadlineMs', 1000, /deadlineMs= is not taken/],
  ['unitBatches', false, /unitBatches= is not taken/],
  ['unitBatchBudget', 400, /unitBatchBudget= is not taken/],
  ['unitAgentCeiling', 9000, /unitAgentCeiling= is not taken/],
  ['costModel', {}, /costModel= is not taken/],
  ['files', ['a.rs'], /files= is not taken/],
  ['batch', 2, /batch= is not taken/],
  ['maxRetries', 1, /maxRetries= is not taken/],
  ['_memory', 'none', /_memory= is not taken/],
  ['_memoryParts', {}, /_memoryParts= is not taken/],
  ['_externals', [], /_externals= is not taken/],
  ['_knownExternals', [], /_knownExternals= is not taken/],
  ['intnet', 'typo', /intnet= is not taken: it is no option of cli-review, which takes repo, base/],
  ['optional', 7, /optional=7 is not true, all or a list of lens names/],
  ['_via', 'rust audit; rm', /_via=.* is not an engine name/],
  ['_recalled', 'yes', /_recalled="yes" is not true or false/],
]

test.each(REFUSED)('%s is refused with nothing run and no record', async (key, value, why) => {
  const run = await runWith({ [key]: value })
  assert.deepEqual(run.calls, [], 'no agent: not the binary, not the logger')
  assert.match(run.report, why)
  assert.match(run.report, /^## Verdict\n\n⚠️ INCOMPLETE — cli-review: .*\. Nothing ran\.$/)
})

test('optional and _recalled reach the binary\'s start as --optional and --no-recall; absent, neither', async () => {
  /** @param {Record<string, unknown>} args */
  const start = async args => String((await runWith(args)).calls.find(c => c.label === 'step:start')?.prompt)
  assert.match(await start({ optional: 'rust-performance' }), /review start --cwd \. --optional 'rust-performance'$/m)
  assert.match(await start({ optional: ['performance', 'api-boundary'], _recalled: true }), /--optional 'performance,api-boundary' --no-recall$/m)
  assert.match(await start({ optional: true }), /--optional 'all'$/m)
  const plain = await start({ optional: false, _recalled: false })
  assert.doesNotMatch(plain, /--optional|--no-recall/)
})

test('_via files the record nested under the parent engine', async () => {
  const repo = tmp('craft-swap-repo-')
  const store = tmp('craft-swap-store-')
  /** @param {string[]} a */
  const git = a => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, encoding: 'utf8' }).stdout.trim()
  git(['init', '-q', '-b', 'feat/x'])
  fs.writeFileSync(path.join(repo, 'lib.rs'), 'pub fn f() {}\n')
  git(['add', 'lib.rs'])
  git(['commit', '-q', '-m', 'a'])
  const logger = async (/** @type {{ prompt: string }} */ { prompt }) => asLogger(prompt, repo, store)
  await runEngine('cli-review', {
    args: { repo, craftBin: '/opt/craft', _via: 'rust-audit', _recalled: true },
    script: { 'step:start': finished({ head: git(['rev-parse', 'HEAD']) }), checkpoint: logger, 'log-run': logger },
  })
  const file = fs.readdirSync(store).find(f => f.endsWith('.json'))
  const rec = JSON.parse(fs.readFileSync(path.join(store, String(file)), 'utf8'))
  assert.deepEqual([rec.nested, rec.via], [true, 'rust-audit'])
})

test('the answer lists each finding from the binary\'s JSON; a parent reads a Block from it, with the findings', async () => {
  const run = await runWith({})
  assert.match(run.report, /\n\n## Findings\n\n- \[High\] src\/lib\.rs:3 — f returns 1 where 0 is claimed \(confirmed\)\n- \[Low\] src\/lib\.rs — naming \(unverified\)$/)
  const got = reviewResult('review:crates/a', run.report)
  assert.equal(got.verdict, 'Block')
  assert.match(String(got.findings[0]?.detail), /\[High\] src\/lib\.rs:3/)
})

test('a run the binary held on the usage limit says the stop as a parent reads it, and reads as a Warning', async () => {
  const stopped = { cause: 'limit', text: 'You have hit your limit · resets 5pm' }
  // The binary's line names the stop already; the answer names it once.
  const said = await runWith({}, { verdict: 'Approve', line: `Approve (INCOMPLETE) — stopped: usage limit reached (${stopped.text}). Resume once the limit resets`, stopped, findings: [] })
  assert.equal(said.report.split('stopped: usage limit reached').length, 2, said.report)
  // A line that does not, the answer adds it.
  const bare = finishedAnswer({ run: RUN, report: `${RUN}/report.md`, verdict: 'Approve (INCOMPLETE)', line: '', degraded: false, stopped: true, stopNote: `stopped: usage limit reached (${stopped.text})`, findings: [] })
  for (const report of [said.report, bare]) {
    assert.equal(limitInReport(report), stopped.text)
    assert.equal(reviewResult('review', report).verdict, 'Warning')
    assert.match(String(verdictLine(report)), /^⚠️ Approve \(INCOMPLETE\)/)
  }
})

test('a service step stopped by the usage limit answers with the stop a parent reads', async () => {
  const run = await runEngine('cli-review', {
    args: { craftBin: '/opt/craft' },
    script: { 'step:start': () => { throw new Error('You have hit your limit · resets 5pm') }, ...LOGGED },
  })
  assert.equal(limitInReport(run.report), 'You have hit your limit · resets 5pm')
  assert.equal(reviewResult('review', run.report).verdict, 'Warning')
})
