// `outputTokens` as the turn's shared pool grown while an engine ran (integrations/shared/run-budget.mjs), never the
// session's spend before it, marked `outputTokensScope: 'turn-delta'`; a nested review files none — an indicative
// figure, not the run's own cost, which is `cost` from enrich-cost.
import { afterEach, beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { CALL_SPEND, filedRecord, runEngine } from './engine-harness.mjs'
import { runBudget } from './run-budget.mjs'

// What the session spent before the engine started: far above anything one scripted run dispatches.
const BEFORE = 9_560_764

let RUN = ''
beforeEach(() => {
  RUN = mkdtempSync(join(tmpdir(), 'craft-run-'))
})
afterEach(() => {
  rmSync(RUN, { recursive: true, force: true })
})

test('runBudget counts the pool from its own start and exposes only spent()', () => {
  let spent = 500
  const own = runBudget({ spent: () => spent })
  assert.equal(own.spent(), 0)
  spent = 740
  assert.equal(own.spent(), 240)
  assert.deepEqual(Object.keys(own), ['spent'], "the pool's total and remainder are the turn's, not the run's")
})

test('a pool read below its start is null, said once; no sandbox budget is null', () => {
  let spent = 500
  /** @type {string[]} */
  const logs = []
  const own = runBudget({ spent: () => spent }, line => logs.push(line))
  spent = 100
  assert.deepEqual([own.spent(), own.spent()], [null, null])
  spent = 600
  assert.equal(own.spent(), 100, 'a later reading above the start is a figure again')
  assert.equal(logs.length, 1)
  assert.match(String(logs[0]), /below 500 at the run's start: a reading below it gives no figure \(null\)/)
  assert.equal(runBudget(undefined).spent(), null)
})

/** A service agent's answer carrying `value` as the command's stdout. @param {unknown} value */
const ran = value => ({ exitCode: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' })

test("review: each submit tells the binary the run's own tokens, not the session's", async () => {
  const lens = {
    id: 'lens-intent',
    label: 'lens:intent',
    model: 'opus',
    promptFile: `${RUN}/tasks/lens-intent.md`,
    schemaFile: `${RUN}/tasks/lens-intent.schema.json`,
    answerFile: `${RUN}/answers/lens-intent.json`,
  }
  const run = await runEngine('review', {
    args: { repo: '/work/repo', base: 'origin/main', craftBin: '/opt/craft' },
    budgetSpent: BEFORE,
    script: {
      'step:locate': ran('root=/home/u/.claude/plugins/cache/craft/craft/0.40.1\n'),
      'step:start': ran({ run: RUN, tasks: [lens], done: false }),
      lens: (/** @type {{ prompt: string }} */ { prompt }) => {
        const file = /to (\/\S+\.json) \(create/.exec(prompt)?.[1] ?? ''
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, JSON.stringify({ lens: 'intent', findings: [] }))
        return 'done'
      },
      'step:submit:1': ran({
        run: RUN,
        done: true,
        report: `${RUN}/report.md`,
        verdict: 'Approve',
        filing: { runDir: '', rejoin: false, lost: [], record: 'filed' },
      }),
    },
  })
  const submit = run.calls.find(c => c.label === 'step:submit:1')
  const before = run.calls.indexOf(/** @type {NonNullable<typeof submit>} */ (submit))
  assert.match(
    String(submit?.prompt),
    new RegExp(`--output-tokens ${String(before * CALL_SPEND)} --output-tokens-scope turn-delta --paged$`, 'm'),
    'the calls dispatched before it, nothing of the session before the run',
  )
})

test("rust-audit: the audit's record carries the pool's growth since its start, exactly", async () => {
  const green = { verdict: 'Approve', summary: 'ok', findings: [], evidence: 'Evidence: ran it' }
  const scout = { baseRef: 'main', hasUnsafe: false, crates: [{ name: 'a', path: 'crates/a' }], changedCrates: [], edges: [], repoRoot: '/r', notes: 'n' }
  const r = await runEngine('rust-audit', {
    args: { priorDecisions: [], _recalled: true },
    budgetSpent: BEFORE,
    script: { workflow: () => '## Verdict\n✅ Approve', '*': green, scout },
  })
  const logger = r.calls.findIndex(c => /craft-log-run/.test(c.prompt))
  assert.ok(logger > 0 && r.calls.slice(0, logger).every(c => !c.threw))
  const rec = filedRecord(r)
  assert.deepEqual(
    [rec.outputTokens, rec.outputTokensScope],
    [logger * CALL_SPEND, 'turn-delta'],
    'every dispatch before the record, none of the session before the run, and marked as such',
  )
})

test('review: a nested run (_via) tells the binary no tokens', async () => {
  const lens = {
    id: 'lens-intent',
    label: 'lens:intent',
    model: 'opus',
    promptFile: `${RUN}/tasks/lens-intent.md`,
    schemaFile: `${RUN}/tasks/lens-intent.schema.json`,
    answerFile: `${RUN}/answers/lens-intent.json`,
  }
  const run = await runEngine('review', {
    args: { repo: '/work/repo', base: 'origin/main', craftBin: '/opt/craft', _via: 'rust-audit' },
    budgetSpent: BEFORE,
    script: {
      'step:locate': ran('root=/home/u/.claude/plugins/cache/craft/craft/0.40.1\n'),
      'step:start': ran({ run: RUN, tasks: [lens], done: false }),
      lens: 'done',
      'step:submit:1': ran({
        run: RUN,
        done: true,
        report: `${RUN}/report.md`,
        verdict: 'Approve',
        filing: { runDir: '', rejoin: false, lost: [], record: 'filed' },
      }),
    },
  })
  const submit = String(run.calls.find(c => c.label === 'step:submit:1')?.prompt)
  assert.match(submit, /review submit --run /)
  assert.doesNotMatch(submit, /--output-tokens/, 'the pool is shared with its siblings and its parent, whose record covers it')
})

test("review: a nested run's resume tells the binary no tokens on any submit", async () => {
  const lens = {
    id: 'lens-errors-r1',
    label: 'lens:errors',
    model: 'opus',
    promptFile: `${RUN}/tasks/l.md`,
    schemaFile: `${RUN}/tasks/l.schema.json`,
    answerFile: `${RUN}/answers/l.json`,
  }
  const run = await runEngine('review', {
    args: { craftBin: '/opt/craft', run: RUN, _via: 'rust-audit' },
    budgetSpent: BEFORE,
    script: {
      'step:resume': ran({ run: RUN, tasks: [lens], done: false }),
      lens: 'done',
      'step:submit:1': ran({
        run: RUN,
        done: true,
        report: `${RUN}/report.md`,
        verdict: 'Approve',
        filing: { runDir: '', rejoin: false, lost: [], record: 'filed' },
      }),
    },
  })
  const submits = run.calls.filter(c => /^step:(resume|submit)/.test(c.label)).map(c => c.prompt)
  assert.equal(submits.length, 2, run.report)
  assert.ok(submits[0]?.includes(' --resume '), submits[0])
  for (const p of submits) assert.doesNotMatch(p, /--output-tokens/, 'a nested resume is no more its own pool than its start')
})

for (const [engine, args] of /** @type {Array<[string, Record<string, unknown>]>} */ ([
  ['rust-audit', { repo: '/elsewhere' }],
  ['triage-findings', { report: '/tmp/r.md', bogus: true }],
])) {
  test(`${engine}: a refusal's record spends nothing of the session before it`, async () => {
    const r = await runEngine(engine, { args, budgetSpent: BEFORE })
    const rec = filedRecord(r)
    assert.deepEqual([rec.outputTokens, rec.outputTokensScope], [0, 'turn-delta'])
  })
}

/** A review whose start the binary never answers readably, so the engine files the INCOMPLETE record itself. @param {Record<string, unknown>} args */
const unfinished = args =>
  runEngine('review', {
    args: { repo: '/work/repo', base: 'origin/main', craftBin: '/opt/craft', ...args },
    budgetSpent: BEFORE,
    script: { 'step:locate': ran('root=/home/u/.claude/plugins/cache/craft/craft/0.40.1\n'), 'step:start': ran('not json') },
  })

test("review: the record the engine files itself carries the pool's growth and its scope, and none when nested", async () => {
  const top = filedRecord(await unfinished({}))
  assert.equal(top.verdict, 'INCOMPLETE')
  assert.ok(typeof top.outputTokens === 'number' && top.outputTokens < BEFORE, String(top.outputTokens))
  assert.equal(top.outputTokensScope, 'turn-delta')
  const nested = filedRecord(await unfinished({ _via: 'rust-audit' }))
  assert.deepEqual([nested.verdict, nested.outputTokens, 'outputTokensScope' in nested], ['INCOMPLETE', null, false])
})

test("review: a nested review's refusal files no tokens", async () => {
  const r = await runEngine('review', { args: { bogus: true, _via: 'rust-audit' }, budgetSpent: BEFORE })
  const rec = filedRecord(r)
  assert.deepEqual([rec.verdict, rec.outputTokens, 'outputTokensScope' in rec], ['INCOMPLETE (argument refused)', null, false])
})
