// What a launcher of the JS review meets in the review driver (lib/cli-review-steps.mjs, lib/cli-review-keys.mjs,
// lib/cli-review-verdict.mjs): the arguments it does not take refused with nothing run but the refusal's record, the
// launch options passed on to the binary (`optional`, `_recalled`, `_via` as `--nested` and, for the record it files,
// `--via`),
// and an answer a parent reads per finding and by its stop.
import { afterAll, test } from 'vitest'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runEngine } from './engine-harness.mjs'
import { asBinaryFiling, asLogger } from './logger-replay.mjs'
import { limitInReport } from './limit-report.mjs'
import { reviewResult, verdictLine } from './rust-audit-verdict.mjs'
import { finishedAnswer } from './cli-review-verdict.mjs'

/** @type {string[]} */
const made = []
afterAll(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true })
})

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
  exitCode: 0,
  stderr: '',
  stdout: JSON.stringify({
    run: RUN,
    done: true,
    report: `${RUN}/report.md`,
    verdict: 'Block',
    line: 'Block — 1 High',
    findings: FINDINGS,
    filing: { runDir: '', rejoin: false, lost: [], record: 'filed' },
    ...over,
  }),
})
const LOGGED = { checkpoint: { runDir: '/store/.partial/run-A', error: '' }, 'log-run': { ok: true, output: ['wrote /store/r.json'] } }

/** A run with `args` whose binary is done at once. @param {Record<string, unknown>} args @param {Record<string, unknown>} [over] */
const runWith = (args, over) => runEngine('review', { args: { craftBin: '/opt/craft', ...args }, script: { 'step:start': finished(over), ...LOGGED } })

/** A git repository with one commit and a run store the real logger files into. */
function repoAndStore() {
  const repo = tmp('craft-swap-repo-')
  const store = tmp('craft-swap-store-')
  /** @param {string[]} a */
  const git = a =>
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, encoding: 'utf8' }).stdout.trim()
  git(['init', '-q', '-b', 'feat/x'])
  fs.writeFileSync(path.join(repo, 'lib.rs'), 'pub fn f() {}\n')
  git(['add', 'lib.rs'])
  git(['commit', '-q', '-m', 'a'])
  const logger = async (/** @type {{ prompt: string }} */ { prompt }) => asLogger(prompt, repo, store)
  /** The one record the store holds. */
  const record = () => JSON.parse(fs.readFileSync(path.join(store, String(fs.readdirSync(store).find(f => f.endsWith('.json')))), 'utf8'))
  return { repo, store, logger, record, head: () => git(['rev-parse', 'HEAD']) }
}

// The JS review's arguments the driver does not take, then values it cannot use: each with the class its record files.
const KEY = 'an argument the engine does not take was refused, nothing ran'
const VALUE = 'an argument value review cannot use was refused, nothing ran'
/** @type {Array<[string, unknown, RegExp, string]>} */
const REFUSED = [
  [
    'languages',
    ['rust'],
    /review cannot honour `languages`: each changed file goes to its profile \(Rust, Nix, general\); narrow with path=\. Nothing ran\./,
    KEY,
  ],
  ['deadlineMs', 1000, /cannot honour `deadlineMs`/, KEY],
  ['unitBatches', false, /cannot honour `unitBatches`/, KEY],
  ['unitBatchBudget', 400, /cannot honour `unitBatchBudget`/, KEY],
  ['unitAgentCeiling', 9000, /cannot honour `unitAgentCeiling`/, KEY],
  ['costModel', {}, /cannot honour `costModel`/, KEY],
  ['files', ['a.rs'], /cannot honour `files`/, KEY],
  ['batch', 2, /cannot honour `batch`/, KEY],
  ['maxRetries', 1, /cannot honour `maxRetries`/, KEY],
  ['_memory', 'none', /cannot honour `_memory`/, KEY],
  ['_memoryParts', {}, /cannot honour `_memoryParts`/, KEY],
  ['_externals', [], /cannot honour `_externals`/, KEY],
  ['_knownExternals', [], /cannot honour `_knownExternals`/, KEY],
  ['intnet', 'typo', /review cannot honour `intnet`: not an argument it takes \(it takes repo, base, .*\)\. Nothing ran — re-launch without it\./, KEY],
  ['optional', 7, /review: optional=7 is not true, all or a list of lens names\. Nothing ran\./, VALUE],
  ['_via', 'rust audit; rm', /review: _via=.* is not an engine name\. Nothing ran\./, VALUE],
  ['_recalled', 'yes', /review: _recalled="yes" is not true or false\. Nothing ran\./, VALUE],
  [
    'repo',
    'work/repo',
    /review: repo="work\/repo" is not an absolute path\. Nothing ran\./,
    '`repo` argument refused — not a path an agent can `cd` to, nothing ran',
  ],
]

test.each(REFUSED)('%s is refused with nothing run but its INCOMPLETE record, its class in notRun', async (key, value, why, cls) => {
  const { repo, logger, record } = repoAndStore()
  const run = await runEngine('review', { args: { repo, craftBin: '/opt/craft', [key]: value }, script: { 'log-run': logger } })
  assert.deepEqual(
    run.calls.map(c => c.label),
    ['log-run'],
    'the logger the only agent: not the binary',
  )
  assert.match(run.report, why)
  assert.match(run.report, /^## Verdict\n\n⚠️ INCOMPLETE — review.*Nothing ran.*$/)
  const rec = record()
  assert.deepEqual([rec.name, rec.verdict, rec.notRun], ['review', 'INCOMPLETE (argument refused)', [cls]])
})

test("optional, _recalled and _via reach the binary's start as --optional, --no-recall, --nested and --via; absent, none", async () => {
  /** @param {Record<string, unknown>} args */
  const start = async args => String((await runWith(args)).calls.find(c => c.label === 'step:start')?.prompt)
  assert.match(await start({ optional: 'rust-performance' }), /review start --cwd \. --optional 'rust-performance' --record '[^']+'$/m)
  assert.match(
    await start({ optional: ['performance', 'api-boundary'], _recalled: true }),
    /--optional 'performance,api-boundary' --no-recall --record '[^']+'$/m,
  )
  assert.match(await start({ optional: true, _via: 'rust-audit' }), /--optional 'all' --nested --record '[^']+' --via 'rust-audit'$/m)
  const plain = await start({ optional: false, _recalled: false })
  assert.doesNotMatch(plain, /--optional|--no-recall|--nested|--via/)
})

test('_via files the record nested under the parent engine', async () => {
  const { repo, store, record, head } = repoAndStore()
  const run = await runEngine('review', {
    args: { repo, craftBin: '/opt/craft', _via: 'rust-audit', _recalled: true },
    script: { 'step:locate': { exitCode: 0, stdout: 'root=/opt/plugin\n', stderr: '' }, 'step:start': finished({ head: head() }) },
  })
  assert.deepEqual(
    run.calls.map(c => c.label),
    ['step:locate', 'step:start'],
    'the binary files it, told the parent by --via',
  )
  const done = JSON.parse(String(/** @type {{ stdout: string }} */ (finished({ head: head() })).stdout))
  await asBinaryFiling([[done, 0]], { repo, store, craftVersion: '0.44.0', via: 'rust-audit' })
  const rec = record()
  assert.deepEqual([rec.nested, rec.via], [true, 'rust-audit'])
})

test("the answer lists each finding from the binary's JSON; a parent reads a Block from it, with the findings", async () => {
  const run = await runWith({})
  assert.match(
    run.report,
    /\n\n## Findings\n\n- \[High\] src\/lib\.rs:3 — f returns 1 where 0 is claimed \(confirmed\)\n- \[Low\] src\/lib\.rs — naming \(unverified\)$/,
  )
  const got = reviewResult('review:crates/a', run.report)
  assert.equal(got.verdict, 'Block')
  assert.match(String(got.findings[0]?.detail), /\[High\] src\/lib\.rs:3/)
})

test('a run the binary held on the usage limit says the stop as a parent reads it, and reads as a Warning', async () => {
  const stopped = { cause: 'limit', text: 'You have hit your limit · resets 5pm' }
  // The binary's line names the stop already; the answer names it once.
  const said = await runWith(
    {},
    { verdict: 'Approve', line: `Approve (INCOMPLETE) — stopped: usage limit reached (${stopped.text}). Resume once the limit resets`, stopped, findings: [] },
  )
  assert.equal(said.report.split('stopped: usage limit reached').length, 2, said.report)
  // A line that does not, the answer adds it.
  const bare = finishedAnswer({
    run: RUN,
    report: `${RUN}/report.md`,
    verdict: 'Approve (INCOMPLETE)',
    line: '',
    degraded: false,
    stopped: true,
    stopNote: `stopped: usage limit reached (${stopped.text})`,
    findings: [],
  })
  for (const report of [said.report, bare]) {
    assert.equal(limitInReport(report), stopped.text)
    assert.equal(reviewResult('review', report).verdict, 'Warning')
    assert.match(String(verdictLine(report)), /^⚠️ Approve \(INCOMPLETE\)/)
  }
})

test('a service step stopped by the usage limit answers with the stop a parent reads', async () => {
  const run = await runEngine('review', {
    args: { craftBin: '/opt/craft' },
    script: {
      'step:start': () => {
        throw new Error('You have hit your limit · resets 5pm')
      },
      ...LOGGED,
    },
  })
  assert.equal(limitInReport(run.report), 'You have hit your limit · resets 5pm')
  assert.equal(reviewResult('review', run.report).verdict, 'Warning')
})
