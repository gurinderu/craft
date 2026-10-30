// A dispatch round in which every agent died is the stop, executed end to end (realm @nick/craft, nodes
// #299, #300). Under an account limit the Workflow tool's agent() resolves null with no text, so the limit
// read never fires; a run that kept dispatching into it spent 267-360 dead agents. Here every agent dies
// from the lens phase on, as the live runs did: the round runs its whole ladder, and then nothing more.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'

const DEATHS_NOTE = /^stopped: every agent dispatched in [^\n]+ died with no answer, most likely the account's usage limit or a failure \(the reason shows in the Workflow tool's failures list\)/
// Enough lenses that a numbered streak would have been reached inside the round, too.
const LENSES = ['safety', 'errors', 'concurrency', 'reconciler', 'failure-windows', 'compat', 'tests', 'maintainability', 'intent', 'invariants', 'negative-space']

/** Every agent answers until the first lens dispatch, and none answers from then on. @param {Record<string, unknown>} [o] */
function deadFromLenses(o = {}) {
  let dead = false
  /** @param {unknown} v */
  const live = v => () => (dead ? null : v)
  return {
    detect: live({ baseRef: 'main', files: ['src/lib.rs'], spec: '', branch: 'feat/x', head: 'abc1234' }),
    'prior-round': live({ found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' }),
    checkpoint: live({ runDir: '/store/.partial/run-A', error: '' }),
    'log-run': live({ ok: true, output: ['wrote r.json'] }),
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

test('review: a lens round whose every agent died stops the run after that round, worded as deaths', async () => {
  const run = await runEngine('review', { script: deadFromLenses() })
  const lensCalls = run.calls.filter(c => /^(retry:)?lens:/.test(c.label))
  assert.ok(lensCalls.length >= LENSES.length * 2, `premise: each lens ran its ladder in round 1: ${lensCalls.length}`)
  assert.ok(lensCalls.every(c => / r1$/.test(c.label)), 'every lens dispatch is round 1\'s: no second round')
  assert.ok(!run.calls.some(c => / resurrect\d/.test(c.label)), 'no resurrection sweep after the stop')
  assert.ok(!run.calls.some(c => /^(retry:)?(synthesis|verify|dedup)/.test(c.label)), 'no verification and no synthesis after the stop')
  assert.ok(run.calls.some(c => /^log-run/.test(c.label)), 'the record write is still dispatched')

  assert.match(verdictLine(run.report), /^⚠️ INCOMPLETE — [^\n]*stopped: every agent dispatched in \[rust\] lens round 1 died with no answer/)
  assert.match(run.report, /## ⛔ Agents died without an answer\n[^\n]*once agents answer again[^\n]*craft-log-run\.mjs recover`/)
  assert.doesNotMatch(run.report, /usage limit reached|limit resets/, 'no limit text was seen, and the report does not claim one')
  const rec = filedRecord(run)
  assert.equal(rec?.verdict, 'INCOMPLETE')
  assert.match(String(rec?.notRun[0]), DEATHS_NOTE)
  assert.equal(run.logs.filter(l => /died with no answer/.test(l)).length, 1, 'the log says it once, when it happens')
})

test('review: named extra lenses beside a dead round die with it, and the run still stops', async () => {
  const extras = ['consumer-a', 'consumer-b', 'consumer-c']
  const run = await runEngine('review', { args: { extraLenses: extras }, script: deadFromLenses() })
  assert.equal(run.calls.filter(c => /^(retry:)?extra-lens:/.test(c.label)).length, extras.length * 2, 'premise: each extra lens died through its ladder')
  assert.match(verdictLine(run.report), /^⚠️ INCOMPLETE — [^\n]*stopped: every agent dispatched in \[rust\] lens round 1 died with no answer/)
  assert.ok(!run.calls.some(c => /^(retry:)?(synthesis|verify|dedup)/.test(c.label)), 'no verification and no synthesis after the stop')
})

test('adversarial-review: a verification pass whose every verifier died stops before the critic', async () => {
  const checks = 30
  const findings = Array.from({ length: checks }, (_unused, i) => ({ title: `bug ${i}`, file: `src/f${i}.rs`, line: 3, severity: 'Medium', why: 'w', fix: 'f', category: 'correctness', confidence: 0.9 }))
  const run = await runEngine('adversarial-review', {
    script: {
      scout: { baseRef: 'main', sizeBucket: 'large', lenses: ['correctness', 'security'], changedFiles: ['src/lib.rs'], notes: 'x' },
      'index-warmup': { indexed: false, notes: 'x' },
      review: (/** @type {{ opts: { label?: string } }} */ c) => ({ findings: /correctness/.test(String(c.opts.label)) ? findings : [] }),
      'coverage-critic': { findings: [] },
      'log-run': { ok: true },
      '*': null,
    },
  })
  assert.ok(run.calls.some(c => /^retry2:verify:/.test(c.label)), 'the pass runs its whole retry ladder before the stop')
  assert.ok(!run.calls.some(c => /^coverage-critic/.test(c.label)), 'no critic after the stop')
  assert.equal(run.reportValue.verdict, 'INCOMPLETE')
  const notes = /** @type {string[]} */ (run.reportValue.notRun)
  assert.ok(notes.some(n => DEATHS_NOTE.test(n)), notes.join('\n'))
  assert.ok(!notes.some(n => /usage limit reached|limit resets/.test(n)), 'no limit text was seen, and no note claims one')
  const labels = /** @type {string[]} */ (filedRecord(run)?.notRun)
  assert.ok(labels.includes('agents-died') && !labels.includes('usage-limit'), `labelled as deaths: ${labels.join(', ')}`)
})

test('rust-audit: dimensions and nested reviews that all died stop the audit before the synthesis', async () => {
  const crates = Array.from({ length: 3 }, (_unused, i) => ({ name: `c${i}`, path: `crates/c${i}` }))
  const run = await runEngine('rust-audit', {
    script: {
      scout: { baseRef: 'main', hasUnsafe: false, crates, changedCrates: crates, edges: [], repoRoot: '/r', notes: 'n' },
      workflow: null,
      synthesis: '**Overall verdict:** Approve',
      '*': null,
    },
  })
  assert.ok(!run.calls.some(c => c.label === 'synthesis'), 'no synthesis after the stop')
  assert.match(run.report, /INCOMPLETE \S+ the synthesis did not run[^\n]*every agent dispatched in the audit dimensions died with no answer[^\n]*rerun the audit once agents answer again/)
  assert.doesNotMatch(run.report, /limit resets/)
  assert.match(String(filedRecord(run)?.notRun[0]), DEATHS_NOTE)
})

// On a light pass with no named extra lenses, the discovery agent is dispatched before lens round 1 opens.
// Its death belongs to no round: an attempt counts only in the rounds open when it was dispatched.
test('review: light pass, a dead discovery agent does not stop a lens round that had a live answer', async () => {
  let liveGiven = false
  const run = await runEngine('review', {
    args: { depth: 'light' },
    script: deadFromLenses({
      lens: (/** @type {{ opts: { label?: string } }} */ c) => {
        if (!liveGiven && /^lens:rust:safety r1$/.test(String(c.opts.label))) {
          liveGiven = true
          return { findings: [{ title: 'real bug', file: 'src/lib.rs', line: 3, severity: 'High', why: 'w', fix: 'f', category: 'correctness', confidence: 0.9 }] }
        }
        return null
      },
    }),
  })
  assert.ok(run.calls.some(c => /^(retry:)?extra-lens-discovery/.test(c.label)), 'premise: discovery was dispatched and died')
  assert.ok(!run.logs.some(l => /lens round 1 died with no answer/.test(l)), 'a round with a live answer is not dead')
  assert.ok(run.calls.some(c => /^verify:src\/lib\.rs:3/.test(c.label)), 'the live finding is sent to verification')
})

test('review: light pass, every agent dead with discovery among them stops after lens round 1', async () => {
  const run = await runEngine('review', { args: { depth: 'light' }, script: deadFromLenses() })
  assert.ok(run.calls.some(c => /^(retry:)?extra-lens-discovery/.test(c.label)), 'premise: discovery was dispatched and died')
  assert.match(verdictLine(run.report), /^⚠️ INCOMPLETE — [^\n]*stopped: every agent dispatched in \[rust\] lens round 1 died with no answer/)
  assert.ok(!run.calls.some(c => / resurrect\d/.test(c.label)), 'no resurrection sweep after the stop')
})
