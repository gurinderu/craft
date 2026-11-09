// What a cli-review run leaves behind for the rest of craft (lib/cli-review-record.mjs): the engine runs in the
// harness with the binary's steps scripted, and the binary's own filing of the run (the start checkpoint, the record)
// is replayed through the adapter it runs, lib/cli-review-file.mjs, into the real craft-log-run against a real git
// repository (lib/logger-replay.mjs, asBinaryFiling). The run-store report and the ledger then read what that filing
// produced; the answer opens with a verdict block the report readers parse.
import { afterAll, test } from 'vitest'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run as analyzeRuns } from './analyze-runs.mjs'
import { runEngine } from './engine-harness.mjs'
import { asBinaryFiling } from './logger-replay.mjs'
import { repoKey } from './repo-key.mjs'
import { fingerprint } from './run-record.mjs'
import { branchRuns } from './match-external-runs.mjs'
import { reviewResult, verdictLine } from './rust-audit-verdict.mjs'

/** @type {string[]} */
const made = []
afterAll(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }) })

/** @param {string} prefix @returns {string} */
function tmp(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  made.push(dir)
  return dir
}

/** @param {string[]} args @param {string} cwd @returns {string} */
function git(args, cwd) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}

const FINDINGS = [
  { severity: 'High', file: 'src/lib.rs', line: 3, title: 'f returns 1 where 0 is claimed', ruleId: '', tier: 'confirmed' },
  { severity: 'Low', file: 'src/lib.rs', line: 1, title: 'naming', ruleId: '', tier: 'unverified' },
]

/** The engine's version, the one its record is filed under. */
const VERSION = JSON.parse(fs.readFileSync(new URL('../integrations/claude-code/.claude-plugin/plugin.json', import.meta.url), 'utf8')).version
/** The record as the binary says it filed it. */
const FILED = { runDir: '', rejoin: false, lost: [], record: 'filed' }

/** The step the binary prints when its run is done. @param {string} run @param {string} head @param {Record<string, unknown>} [over] */
const doneStep = (run, head, over = {}) => ({ run, done: true, report: `${run}/report.md`, verdict: 'Block', line: 'Block', head, base: 'origin/main', findings: FINDINGS, uncovered: ['app.py'], notRun: [], filing: FILED, ...over })
/** @param {string} run @param {string} head @param {Record<string, unknown>} [over] */
const finished = (run, head, over = {}) => ({ exitCode: 0, stderr: '', stdout: JSON.stringify(doneStep(run, head, over)) })

/**
 * One cli-review of a one-commit repository whose binary is done at once, its filing replayed as the binary does it;
 * `args` add to the engine's.
 * @param {{ args?: Record<string, unknown>, over?: Record<string, unknown> }} [o]
 */
async function cliRun({ args = {}, over = {} } = {}) {
  const repo = tmp('craft-cli-repo-')
  const store = tmp('craft-cli-store-')
  const runDir = tmp('craft-cli-run-')
  git(['init', '-q', '-b', 'feat/x'], repo)
  fs.writeFileSync(path.join(repo, 'lib.rs'), 'pub fn f() -> u8 { 1 }\n')
  git(['add', 'lib.rs'], repo)
  git(['commit', '-q', '-m', 'a'], repo)
  const first = git(['rev-parse', 'HEAD'], repo)
  const engine = await runEngine('cli-review', { args: { repo, craftBin: '/opt/craft', ...args }, script: { 'step:start': finished(runDir, first, over) } })
  const depth = typeof args['depth'] === 'string' ? args['depth'] : 'full'
  await asBinaryFiling([[doneStep(runDir, first, over), 0]], { repo, store, craftVersion: VERSION, depth, strict: args['strict'] === true })
  const lines = fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  return { repo, store, first, engine, lines }
}

test('a finished cli-review files one record under the branch and head it started on', async () => {
  const { repo, first, engine, lines } = await cliRun()
  assert.deepEqual(engine.calls.map(c => c.label), ['step:start'], 'the binary filed it: no logger agent')
  assert.equal(lines.length, 1)
  assert.deepEqual([lines[0]?.['name'], lines[0]?.['kind'], lines[0]?.['verdict'], lines[0]?.['nested']], ['cli-review', 'workflow', 'Block', false])
  assert.deepEqual([lines[0]?.['branch'], lines[0]?.['head']], ['feat/x', first])
  assert.equal(lines[0]?.['project'], repoKey(repo))
  assert.ok(!engine.logs.some(l => /telemetry/.test(l)), engine.logs.join('\n'))
})

test('the record carries the findings by severity, a ledger row each and the uncovered files; the run-store report reads it', async () => {
  const { store } = await cliRun({ args: { depth: 'light' } })
  const file = fs.readdirSync(store).find(f => f.endsWith('.json'))
  const rec = JSON.parse(fs.readFileSync(path.join(store, String(file)), 'utf8'))
  assert.equal(rec.findings.total, 2)
  assert.deepEqual([rec.findings.bySeverity.High, rec.findings.bySeverity.Low], [1, 1])
  assert.deepEqual(rec.ledger.map((/** @type {Record<string, unknown>} */ r) => [r['severity'], r['file'], r['line'], r['title'], r['tier']]), FINDINGS.map(f => [f.severity, f.file, f.line, f.title, f.tier]))
  assert.ok(rec.ledger.every((/** @type {Record<string, unknown>} */ r) => /^[0-9a-f]{8}$/.test(String(r['fp']))), 'each row is fingerprinted as review\'s are')
  assert.deepEqual([rec.uncoveredFiles, rec.notRun, rec.base, rec.depth], [['app.py'], [], 'origin/main', 'light'])
  const out = (await analyzeRuns([store], process.env)).stdout.join('\n')
  assert.match(out, /- cli-review: 1 run\(s\)/, out)
})

test('the answer opens with a verdict block the report readers parse, naming why when nothing was reviewed', async () => {
  const red = await cliRun()
  assert.equal(verdictLine(red.engine.report), '⛔ Block')
  assert.equal(reviewResult('d', red.engine.report).verdict, 'Block')
  const why = '⚠️ INCOMPLETE — NOTHING WAS REVIEWED — none of the 1 changed file(s) match a supported language profile (this engine reviews Rust only)'
  const none = await cliRun({ over: { verdict: 'INCOMPLETE (no language profile)', line: why, findings: [], uncovered: ['main.py'] } })
  assert.equal(verdictLine(none.engine.report), why, 'the binary\'s own line, not a bare INCOMPLETE')
  assert.equal(none.lines[0]?.['verdict'], 'INCOMPLETE (no language profile)')
  const partial = 'Approve (PARTIAL COVERAGE) — 1 changed file(s) matched no language profile and were NOT reviewed (app.py): this verdict covers only the files the Rust profile reviewed'
  const some = await cliRun({ over: { verdict: 'Approve (PARTIAL COVERAGE)', line: partial, findings: [] } })
  assert.equal(verdictLine(some.engine.report), `⚠️ ${partial}`)
  assert.equal(reviewResult('d', some.engine.report).verdict, 'Warning', 'a partial coverage voids a green verdict')
})

test('the caller\'s depth reaches `craft review start`; without one the binary\'s default stands', async () => {
  const light = await cliRun({ args: { depth: 'light' } })
  assert.match(String(light.engine.calls[0]?.prompt), /review start --cwd '[^']+' --depth light --record '[^']+'$/m)
  const none = await cliRun()
  assert.doesNotMatch(String(none.engine.calls[0]?.prompt), /--depth/)
  const file = fs.readdirSync(none.store).find(f => f.endsWith('.json'))
  assert.equal(JSON.parse(fs.readFileSync(path.join(none.store, String(file)), 'utf8')).depth, 'full', 'the record names the depth the binary ran at')
})

test('a run the binary never finished files an INCOMPLETE record without a reviewed head', async () => {
  const run = await runEngine('cli-review', {
    args: { craftBin: '/opt/craft' },
    script: { 'step:start': { exitCode: 1, stdout: '', stderr: 'craft: no base' }, 'log-run': { ok: true, output: ['wrote /store/r.json'] } },
  })
  const rec = JSON.parse(String(run.calls.find(c => c.label === 'log-run')?.prompt).split(/\nRECORD:\n/)[1] ?? 'null')
  assert.deepEqual([rec.name, rec.verdict, rec.notRun], ['cli-review', 'INCOMPLETE', ['the craft binary did not finish the run']])
  assert.ok(!run.calls.some(c => c.label.startsWith('checkpoint')), 'no checkpoint: the binary read no diff')
})

test('a record the binary could not file is said after the verdict block, which still parses, with how to file it again', async () => {
  const failed = { runDir: '/store/.partial/run-A', rejoin: false, lost: ['the run record — craft-log-run FAILED: boom'], record: 'failed' }
  const run = await runEngine('cli-review', {
    args: { craftBin: '/opt/craft' },
    script: { 'step:start': finished('/tmp/run-x', 'abc1234', { filing: failed }) },
  })
  assert.equal(verdictLine(run.report), '⛔ Block')
  assert.match(run.report, /read that file for the findings \(run \/tmp\/run-x\)\.\n\n## Findings\n\n(- .*\n)+\n## ⚠️ Telemetry lost\n/)
  assert.match(run.report, /- the run record — craft-log-run FAILED: boom/)
  assert.match(run.report, /The run record can be filed again: the Workflow `craft:cli-review run=\/tmp\/run-x`/)
  assert.deepEqual(run.calls.map(c => c.label), ['step:start'], 'the driver files nothing in its place')
})

test('a finished run whose binary reported no filing says its record is missing, never leaves it to be inferred', async () => {
  const run = await runEngine('cli-review', {
    args: { craftBin: '/opt/craft' },
    script: { 'step:start': finished('/tmp/run-x', 'abc1234', { filing: undefined }) },
  })
  assert.match(run.report, /## ⚠️ Telemetry lost\n/)
  assert.match(run.report, /- the run record — the craft binary reported no telemetry write/)
})

test('a re-review round files its round, the binary\'s ledger with each row\'s disposition and how it built on the last', async () => {
  const ledger = [
    { file: 'src/lib.rs', line: 4, symbol: '', severity: 'High', tier: 'confirmed', disposition: 'open', source: 'errors', ruleId: 'RS-Y', title: 'Y', why: 'w — fix incomplete: still', toolRule: 'clippy::a', sources: ['clippy', 'errors'] },
    { file: 'src/lib.rs', line: 1, symbol: '', severity: 'High', tier: 'confirmed', disposition: 'closed', source: 'errors', ruleId: 'RS-X', title: 'X', why: 'resolved in round 2' },
  ]
  const reReview = { chained: true, priorRound: 1, scope: 'fixes', resolved: 1, stillOpen: 1 }
  const { store, lines } = await cliRun({ over: { findings: [], round: 2, ledger, reReview } })
  const file = fs.readdirSync(store).find(f => f.endsWith('.json'))
  const rec = JSON.parse(fs.readFileSync(path.join(store, String(file)), 'utf8'))
  assert.deepEqual([rec.round, lines[0]?.['round'], rec.findings.total], [2, 2, 0])
  assert.deepEqual(rec.ledger.map((/** @type {Record<string, unknown>} */ r) => [r['ruleId'], r['disposition'], r['why']]), ledger.map(r => [r.ruleId, r.disposition, r.why]))
  assert.ok(rec.ledger.every((/** @type {Record<string, unknown>} */ r) => /^[0-9a-f]{8}$/.test(String(r['fp']))))
  assert.deepEqual(rec.reReview, reReview)
  assert.deepEqual([rec.ledger[0].toolRule, rec.ledger[0].sources, 'toolRule' in rec.ledger[1]], ['clippy::a', ['clippy', 'errors'], false], 'a tool\'s rule and the sources ride the ledger as the engine\'s do')
})

test('a round over the fix commits alone files lensScope delta, which the external-findings matcher does not count as coverage', async () => {
  const delta = await cliRun({ over: { round: 2, lensScope: 'delta' } })
  const full = await cliRun()
  /** @param {{ store: string, repo: string, first: string }} r */
  const runOf = r => {
    const file = fs.readdirSync(r.store).find(f => f.endsWith('.json'))
    const rec = JSON.parse(fs.readFileSync(path.join(r.store, String(file)), 'utf8'))
    return branchRuns([rec], { headRefName: 'feat/x', commits: [{ oid: r.first }], reviews: [] }, new Set([repoKey(r.repo)]))
  }
  assert.deepEqual(runOf(delta).map(r => r.delta), [true])
  assert.deepEqual(runOf(full).map(r => r.delta), [false], 'a first round, or a full re-scan, covers the whole diff')
})

test('fresh and fullEvery reach `craft review start`; the binary picks the round to build on; a bad one runs nothing', async () => {
  const chained = await cliRun({ args: { fresh: true, fullEvery: 0 } })
  assert.match(String(chained.engine.calls[0]?.prompt), /review start --cwd '[^']+' --fresh --full-every 0 --record '[^']+'$/m)
  const plain = await cliRun()
  assert.doesNotMatch(String(plain.engine.calls[0]?.prompt), /--fresh|--full-every/)
  const file = fs.readdirSync(plain.store).find(f => f.endsWith('.json'))
  assert.equal(JSON.parse(fs.readFileSync(path.join(plain.store, String(file)), 'utf8')).round, 1, 'a binary that names no round files round 1')
  for (const bad of [{ fullEvery: -1 }, { fullEvery: 'often' }, { fresh: 'yes' }]) {
    const run = await runEngine('cli-review', { args: { craftBin: '/opt/craft', ...bad }, script: { 'log-run': { ok: true, output: ['wrote /store/r.json'] } } })
    assert.match(run.report, /^## Verdict\n\n⚠️ INCOMPLETE — cli-review: (fullEvery|fresh)=.* Nothing ran\.$/, run.report)
    assert.deepEqual(run.calls.map(c => c.label), ['log-run'])
  }
})

test('strict and the launcher\'s priorDecisions reach `craft review start`, the list on its stdin; the record keeps the memory and strict', async () => {
  const rejected = [{ kind: 'decision', title: 'it\'s fine', body: 'line one\nline two', scope: 'src', commit: 'abc1234' }]
  const memory = { source: 'none', count: 0, why: 'no memory configured (backend none)', backend: 'none', passed: 1, added: 1 }
  const run = await cliRun({ args: { strict: true, priorDecisions: rejected }, over: { memory, strict: true } })
  const prompt = String(run.engine.calls[0]?.prompt)
  assert.match(prompt, /review start --cwd '[^']+' --strict --record '[^']+' --prior-decisions - <<'CRAFT_PRIOR_DECISIONS'\n.*\nCRAFT_PRIOR_DECISIONS$/m)
  assert.deepEqual(JSON.parse(String(/<<'CRAFT_PRIOR_DECISIONS'\n(.*)\n/.exec(prompt)?.[1])), rejected, 'the list reaches the binary whole, one line of JSON')
  const file = fs.readdirSync(run.store).find(f => f.endsWith('.json'))
  const rec = JSON.parse(fs.readFileSync(path.join(run.store, String(file)), 'utf8'))
  assert.deepEqual([rec.memory, rec.strict], [memory, true])
  const plain = await cliRun()
  assert.doesNotMatch(String(plain.engine.calls[0]?.prompt), /--strict|--prior-decisions/)
  const bad = await runEngine('cli-review', { args: { craftBin: '/opt/craft', strict: 'yes' }, script: { 'log-run': { ok: true, output: ['wrote /store/r.json'] } } })
  assert.match(bad.report, /^## Verdict\n\n⚠️ INCOMPLETE — cli-review: strict="yes" is not true or false\. Nothing ran\.$/, bad.report)
})

test('unitScope reaches `craft review start` as --unit-scope only when true; anything but a boolean is refused', async () => {
  const on = await cliRun({ args: { unitScope: true } })
  assert.match(String(on.engine.calls[0]?.prompt), /review start --cwd '[^']+' --unit-scope --record '[^']+'$/m)
  const off = await cliRun({ args: { unitScope: false } })
  assert.doesNotMatch(String(off.engine.calls[0]?.prompt), /--unit-scope/)
  const bad = await runEngine('cli-review', { args: { craftBin: '/opt/craft', unitScope: 'yes' }, script: { 'log-run': { ok: true, output: ['wrote /store/r.json'] } } })
  assert.match(bad.report, /^## Verdict\n\n⚠️ INCOMPLETE — cli-review: unitScope="yes" is not true or false\. Nothing ran\.$/, bad.report)
})

test('extraLenses reaches `craft review start` as --extra-lenses: a list joined, false or [] as off, absent as nothing', async () => {
  const named = await cliRun({ args: { extraLenses: ['reviewer', "it's"] } })
  assert.match(String(named.engine.calls[0]?.prompt), /review start --cwd '[^']+' --extra-lenses 'reviewer,it'\\''s' --record '[^']+'$/m)
  for (const off of [false, []]) {
    const run = await cliRun({ args: { extraLenses: off } })
    assert.match(String(run.engine.calls[0]?.prompt), /review start --cwd '[^']+' --extra-lenses 'off' --record '[^']+'$/m)
  }
  const plain = await cliRun()
  assert.doesNotMatch(String(plain.engine.calls[0]?.prompt), /--extra-lenses/, 'absent: the binary decides, discovering on a light pass')
  const bad = await runEngine('cli-review', { args: { craftBin: '/opt/craft', extraLenses: { a: 1 } }, script: { 'log-run': { ok: true, output: ['wrote /store/r.json'] } } })
  assert.match(bad.report, /^## Verdict\n\n⚠️ INCOMPLETE — cli-review: extraLenses=\{"a":1\} is not a list of agent names\. Nothing ran\.$/, bad.report)
})

test('gate=false starts the binary with --no-gate, so no tool builds the branch; any other value is refused', async () => {
  const off = await cliRun({ args: { gate: false } })
  assert.match(String(off.engine.calls[0]?.prompt), /review start --cwd '[^']+' --no-gate --record '[^']+'$/m)
  const on = await cliRun({ args: { gate: true } })
  assert.doesNotMatch(String(on.engine.calls[0]?.prompt), /--no-gate/)
  const bad = await runEngine('cli-review', { args: { craftBin: '/opt/craft', gate: 'off' }, script: { 'log-run': { ok: true, output: ['wrote /store/r.json'] } } })
  assert.match(bad.report, /^## Verdict\n\n⚠️ INCOMPLETE — cli-review: gate="off" is not true or false\. Nothing ran\.$/, bad.report)
})

test('comment reaches `craft review start` as --comment; the record keeps the sorting, the fingerprinted contradictions and what was posted, and the answer says what landed', async () => {
  const key = { file: 'src/lib.rs', symbol: 'fn f', ruleId: '', title: 'f returns 1 where 0 is claimed' }
  const sorting = { defect: 1, doubtful: 1, inDiffJudged: true, findings: [{ n: 1, severity: 'Medium', title: 'g', file: 'src/lib.rs', line: 9, why: 'w', fix: 'x', source: 'intent', toolRule: '', outsideDiff: false }] }
  const item = { record: 'D-1', kind: 'decision', severity: 'High', title: key.title, file: key.file, line: 3, doubtSigns: [], toPr: true }
  const memoryContradictions = { count: 1, doubtSignsAlone: 0, inDiffJudged: true, findings: [{ key, ...item }] }
  const prComments = { pr: 7, url: 'u', requested: 1, posted: 0, already: 0, failed: 0, noFile: 0, reason: 'gh pr view failed: HTTP 401', error: 'gh pr view failed: HTTP 401' }
  const run = await cliRun({ args: { comment: true }, over: { sorting, memoryContradictions, prComments } })
  assert.match(String(run.engine.calls[0]?.prompt), /review start --cwd '[^']+' --comment --record '[^']+'$/m)
  const file = fs.readdirSync(run.store).find(f => f.endsWith('.json'))
  const rec = JSON.parse(fs.readFileSync(path.join(run.store, String(file)), 'utf8'))
  assert.deepEqual([rec.sorting, rec.prComments], [sorting, prComments])
  assert.deepEqual(rec.memoryContradictions, { ...memoryContradictions, findings: [{ fp: fingerprint(key), ...item }] }, 'fingerprinted as the ledger rows are')
  assert.match(run.engine.report, /\n\n⚠️ PR comments: 0 of 1 defect\(s\) posted, 0 already on the PR — gh pr view failed: HTTP 401\.\n\nDoubtful: 1 finding\(s\) held back from the PR/)
  const plain = await cliRun()
  assert.doesNotMatch(String(plain.engine.calls[0]?.prompt), /--comment/)
  assert.doesNotMatch(plain.engine.report, /PR comments|Doubtful/)
  const bad = await runEngine('cli-review', { args: { craftBin: '/opt/craft', comment: 'yes' }, script: { 'log-run': { ok: true, output: ['wrote /store/r.json'] } } })
  assert.match(bad.report, /^## Verdict\n\n⚠️ INCOMPLETE — cli-review: comment="yes" is not true or false\. Nothing ran\.$/, bad.report)
})
