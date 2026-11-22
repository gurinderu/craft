// A run's own output tokens, not the session's (integrations/shared/run-budget.mjs): every engine that files
// `outputTokens` counts from its own start, the session's spend before it left out.
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

test('runBudget counts from its own start and keeps the total and what remains', () => {
  let spent = 500
  const own = runBudget({ total: 1000, spent: () => spent, remaining: () => 1000 - spent })
  assert.equal(own.spent(), 0)
  spent = 740
  assert.deepEqual([own.spent(), own.remaining(), own.total], [240, 260, 1000])
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
    new RegExp(`--output-tokens ${String(before * CALL_SPEND)}$`, 'm'),
    'the calls dispatched before it, nothing of the session before the run',
  )
})

test("rust-audit: the audit's record carries its own tokens", async () => {
  const green = { verdict: 'Approve', summary: 'ok', findings: [], evidence: 'Evidence: ran it' }
  const scout = { baseRef: 'main', hasUnsafe: false, crates: [{ name: 'a', path: 'crates/a' }], changedCrates: [], edges: [], repoRoot: '/r', notes: 'n' }
  const r = await runEngine('rust-audit', {
    args: { priorDecisions: [], _recalled: true },
    budgetSpent: BEFORE,
    script: { workflow: () => '## Verdict\n✅ Approve', '*': green, scout },
  })
  const tokens = filedRecord(r).outputTokens
  assert.ok(typeof tokens === 'number' && tokens > 0 && tokens < r.calls.length * CALL_SPEND, String(tokens))
})

for (const [engine, args] of /** @type {Array<[string, Record<string, unknown>]>} */ ([
  ['rust-audit', { repo: '/elsewhere' }],
  ['triage-findings', { report: '/tmp/r.md', bogus: true }],
])) {
  test(`${engine}: a refusal's record spends nothing of the session before it`, async () => {
    const r = await runEngine(engine, { args, budgetSpent: BEFORE })
    assert.equal(filedRecord(r).outputTokens, 0)
  })
}
