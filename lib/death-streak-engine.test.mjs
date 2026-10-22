// The run-wide death streak, executed end to end (realm @nick/craft, nodes #299, #300). Under an account
// limit the Workflow tool's agent() resolves null with no text, so the limit read never fires; a run
// that kept dispatching into it spent 267-360 dead agents. Here every agent dies from the lens phase on,
// as the live runs did, and the engine must stop shortly after DEATH_STREAK_STOP deaths in a row.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'
import { DEATH_STREAK_STOP } from './usage-limit.mjs'

const STREAK_NOTE = new RegExp(`^stopped: ${DEATH_STREAK_STOP} agents in a row died with no answer, most likely an account usage limit \\(the reason shows in the Workflow tool's failures list\\)`)
const LOW = { title: 'a nit', file: 'src/lib.rs', line: 3, severity: 'Low', why: 'w', fix: 'f', ruleId: '' }
const LENSES = ['safety', 'errors', 'concurrency', 'maintainability', 'tests', 'intent']

/** Every agent answers until the first lens dispatch, and none answers from then on. @param {Record<string, unknown>} [o] */
function deadFromLenses(o = {}) {
  let dead = false
  /** @param {unknown} v */
  const live = v => () => (dead ? null : v)
  return {
    detect: live({ baseRef: 'main', files: ['src/lib.rs'], spec: '', branch: 'feat/x', head: 'abc1234' }),
    'prior-round': live({ found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' }),
    checkpoint: live({ runDir: '/store/.partial/run-A', error: '' }),
    'log-run': live({ ok: true, error: '' }),
    scout: live({ sizeBucket: 'medium', lenses: LENSES, isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' }),
    gate: live({ status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' }),
    lens: () => { dead = true; return null },
    '*': null,
    ...o,
  }
}

/** @param {string} report @returns {string} */
const verdictLine = report => {
  const lines = report.split('\n')
  const head = lines.findIndex(l => /^#+\s*Verdict\b/i.test(l.trim()))
  return String(lines.find((l, i) => i > head && l.trim()))
}

test('review: agents that keep dying with no answer stop the run shortly after the streak', async () => {
  const run = await runEngine('review', { script: deadFromLenses() })
  const lensCalls = run.calls.filter(c => /^(retry:)?lens:/.test(c.label))
  // Without the stop each lens spends its whole ladder: reviewer agent and generic subagent, each
  // re-dispatched once, in its round and two resurrection sweeps.
  const fanOut = LENSES.length * 4 * 3
  assert.ok(lensCalls.length <= DEATH_STREAK_STOP + 2 * LENSES.length,
    `only the streak and what was already in flight: ${lensCalls.length} lens dispatches`)
  assert.ok(lensCalls.length < fanOut / 2, `far below the ${fanOut} of the full retry fan-out: ${lensCalls.length}`)
  assert.ok(!run.calls.some(c => / resurrect\d/.test(c.label)), 'no resurrection sweep after the stop')
  assert.ok(!run.calls.some(c => /^(retry:)?(synthesis|verify|dedup)/.test(c.label)), 'no verification and no synthesis after the stop')
  assert.ok(run.calls.some(c => /^log-run/.test(c.label)), 'the record write is still dispatched')

  assert.match(verdictLine(run.report), /^\u26a0\ufe0f INCOMPLETE \u2014 [^\n]*stopped: \d+ agents in a row died with no answer/)
  assert.match(run.report, /## \u26d4 Agents keep dying with no answer\n[^\n]*once the limit resets[^\n]*craft-log-run\.mjs recover`/)
  assert.doesNotMatch(run.report, /usage limit reached/, 'no limit text was seen, and the report does not claim one')
  const rec = filedRecord(run)
  assert.equal(rec?.verdict, 'INCOMPLETE')
  assert.match(String(rec?.notRun[0]), STREAK_NOTE)
  assert.equal(run.logs.filter(l => /agents in a row died with no answer/.test(l)).length, 1, 'the log says it once, when it happens')
})

test('review: lenses that time out on the deadline are not deaths and stop nothing', async () => {
  // Every lens hangs past its (shortened) deadline: a live agent taking too long, not a dead one.
  const run = await runEngine('review', { args: { deadlineMs: 50 }, script: deadFromLenses({ lens: () => new Promise(() => {}) }) })
  assert.ok(run.logs.some(l => /exhausted its .* budget with no response/.test(l)), 'premise: the deadline fired')
  assert.doesNotMatch(run.report, /agents in a row died/)
  assert.ok(run.calls.some(c => / resurrect\d/.test(c.label)), 'the resurrection sweep still runs')
  assert.match(verdictLine(run.report), /INCOMPLETE/, 'the lenses that never returned still make it INCOMPLETE')
})

test('review: one lens that keeps dying is a dead lens, not a stop', async () => {
  const live = deadFromLenses()
  const run = await runEngine('review', {
    script: {
      ...live,
      'log-run': { ok: true, error: '' },
      checkpoint: { runDir: '/store/.partial/run-A', error: '' },
      lens: (/** @type {{ opts: { label?: string } }} */ c) => (/:tests /.test(String(c.opts.label)) ? null : { lens: 'x', findings: /:safety /.test(String(c.opts.label)) ? [LOW] : [] }),
      dedup: { groups: [] },
      synthesis: '## Verdict\n\u2705 Approve \u2014 clean.\n',
    },
  })
  assert.ok(run.calls.filter(c => /^(retry:)?lens:rust:tests /.test(c.label)).length >= 12, 'premise: the dead lens spent its whole ladder')
  assert.doesNotMatch(run.report, /agents in a row died/)
  assert.ok(run.calls.some(c => c.label === 'synthesis'), 'the synthesis still runs')
  assert.match(verdictLine(run.report), /INCOMPLETE/, 'and the dead lens makes the verdict INCOMPLETE')
})

test('adversarial-review: lenses that keep dying stop the retry rounds, the critic and the verifiers', async () => {
  const lenses = ['correctness', 'security', 'money', 'concurrency', 'errors', 'performance', 'complexity']
  const run = await runEngine('adversarial-review', {
    script: {
      scout: { baseRef: 'main', sizeBucket: 'large', lenses, changedFiles: ['src/lib.rs'], notes: 'x' },
      'index-warmup': { indexed: false, notes: 'x' },
      'coverage-critic': { findings: [] },
      'log-run': { ok: true },
      '*': null,
    },
  })
  const lensCalls = run.calls.filter(c => /^(retry\d+:)?review:/.test(c.label))
  assert.ok(lensCalls.length <= DEATH_STREAK_STOP + lenses.length, `only the streak and what was in flight: ${lensCalls.length}`)
  assert.ok(run.calls.filter(c => /^retry2:/.test(c.label)).length < lenses.length - 1, 'the second retry round is cut short by the stop')
  assert.ok(!run.calls.some(c => /^coverage-critic|^verify/.test(c.label)), 'no critic and no verifier after the stop')
  assert.equal(run.reportValue.verdict, 'INCOMPLETE')
  assert.ok(run.reportValue.notRun.some((/** @type {string} */ n) => STREAK_NOTE.test(n)), run.reportValue.notRun.join('\n'))
  assert.ok(!run.reportValue.notRun.some((/** @type {string} */ n) => /usage limit reached/.test(n)), 'no limit text was seen')
})

test('rust-audit: a nested review that stopped on a death streak stops the audit', async () => {
  const note = `stopped: ${DEATH_STREAK_STOP} agents in a row died with no answer, most likely an account usage limit (the reason shows in the Workflow tool's failures list)`
  const nested = `## ⛔ Agents keep dying with no answer\n${note}. The run record was attempted\n\n## Verdict\n⚠️ INCOMPLETE — x`
  const run = await runEngine('rust-audit', {
    script: {
      scout: { baseRef: 'main', hasUnsafe: false, crates: [{ name: 'a', path: 'crates/a' }], changedCrates: [], edges: [], repoRoot: '/r', notes: 'n' },
      workflow: nested, synthesis: '**Overall verdict:** Approve', '*': { verdict: 'Approve', summary: 'ok', findings: [], evidence: 'Evidence: ran it' },
    },
  })
  assert.ok(!run.calls.some(c => c.label === 'synthesis'), 'no synthesis after the nested stop')
  assert.match(run.report, /INCOMPLETE \S+ the synthesis did not run[^\n]*agents in a row died with no answer/)
  const rec = filedRecord(run)
  assert.match(String(rec?.verdict), /INCOMPLETE/)
  assert.equal(String(rec?.notRun[0]), note)
})
