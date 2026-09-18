// WHICH lenses a run pays for, executed rather than read.
//
// A lens is a full agent — the engine's dominant per-run cost — so a lens that arrives as a side
// effect of an unrelated floor is spend with no signal behind it. `failure-windows` is the case:
// its own gate is the `reconciler` lens ("controller code"), enforced in code because a prompt-side
// "also include" measurably gets dropped. But it also sits in `profile.lenses`, and every blanket
// expansion of that list — the security-sensitive rigor floor, the empty-lens fallback, and the
// conservative plan used when the scout DIES — pulled it in on any Rust diff whatsoever. So the
// most expensive lens in the roster ran on diffs with no controller in them, which is the opposite
// of "find more without paying hugely".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'

// Every lens the run actually dispatched an agent for.
const ranLenses = calls => calls.filter(c => c.key === 'lens').map(c => String(c.opts?.label || ''))
const ran = (calls, lens) => ranLenses(calls).some(l => l.includes(lens))

function script({ scout }) {
  return {
    detect: { baseRef: 'main', files: ['src/lib.rs'], spec: '', branch: 'feat/x', head: 'abc1234' },
    'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
    checkpoint: { runDir: '/store/.partial/run-A', error: '' },
    'log-run': { ok: true, error: '' },
    scout,
    gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
    lens: { lens: 'x', findings: [] },
    dedup: { groups: [] },
    synthesis: null,
    '*': null,
  }
}

test('the security floor does not buy the failure-windows lens on a diff with no controller in it', async () => {
  const { calls } = await runEngine('review', {
    args: {},
    script: script({
      scout: { sizeBucket: 'small', lenses: ['safety'], isLibrary: false, securitySensitive: true, intent: '', churn: [], notes: 'x' },
    }),
  })
  assert.ok(ran(calls, 'safety'), 'the scouted lens still runs')
  assert.ok(ran(calls, 'errors'), 'and the security floor still widens the roster')
  assert.ok(!ran(calls, 'failure-windows'),
    'but failure-windows is admitted by its own signal only — the floor must not buy it')
})

test('a dead scout does not buy the failure-windows lens either', async () => {
  // The conservative fallback plan is `all lenses`, and a dead scout is exactly when nothing is
  // known about the diff — so a blanket roster is right for everything EXCEPT a lens whose whole
  // premise is a code shape the fallback cannot claim to have seen.
  const { calls } = await runEngine('review', { args: {}, script: script({ scout: null }) })
  assert.ok(ranLenses(calls).length > 3, 'the fallback still runs a wide roster')
  assert.ok(!ran(calls, 'failure-windows'), 'without its signal, the most expensive lens is not in it')
})

test('the reconciler signal DOES buy failure-windows — the gating is not a removal', async () => {
  const { calls } = await runEngine('review', {
    args: {},
    script: script({
      scout: { sizeBucket: 'small', lenses: ['reconciler'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
    }),
  })
  assert.ok(ran(calls, 'reconciler'))
  assert.ok(ran(calls, 'failure-windows'), 'controller code is what the lens is for, and it still runs there')
})

// ---- notRun is RANKED BY EXACT STRING, so it carries a class, not a run's own paths ------------
// `lib/analyze-runs.mjs` tallies `notRun` entries by exact string to surface repeated fragility,
// and this codebase already documents that as the reason not to embed per-run detail: the
// uncovered-files note was pulled out of `notRun` for precisely this ("a note embedding a count and
// file names is unique per run — it filled the ranking with count-1 rows and sank the real
// repeats"). The two scope refusals then went and embedded the caller's `path` and `repo`, so every
// bad dispatch of the same shape ranks as its own count-1 row and the repeated misuse is invisible.
// The detail is not lost — it stays in the log and in the report's Scope section, neither of which
// is ranked.
const notRunOf = rec => (rec?.notRun || []).join('\n')

test('the dropped-scope refusal ranks as a class, not as this run\'s paths', async () => {
  const { filedRecord } = await import('./engine-harness.mjs')
  const run = await runEngine('review', {
    args: { repo: '/repos/mine', path: '/somewhere/else/crates/foo' },
    script: script({ scout: { sizeBucket: 'small', lenses: ['safety'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' } }),
  })
  const nr = notRunOf(filedRecord(run))
  assert.match(nr, /scope/i, 'the class of refusal is named')
  assert.ok(!/somewhere\/else/.test(nr), 'but the run\'s own path does not enter the ranked string')
  assert.ok(!/\/repos\/mine/.test(nr), 'nor the run\'s own repo')
  assert.ok(run.report.includes('/somewhere/else/crates/foo'),
    'the detail still reaches the reader, in the report — it is the RANKED string that must be stable')
})

test('the ambiguous-path refusal ranks as a class too', async () => {
  const { filedRecord } = await import('./engine-harness.mjs')
  const run = await runEngine('review', {
    args: { path: '/an/absolute/path' },
    script: script({ scout: { sizeBucket: 'small', lenses: ['safety'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' } }),
  })
  const nr = notRunOf(filedRecord(run))
  assert.ok(nr.length > 0, 'the refusal is recorded — a refusal that files nothing is invisible to the fragility ranking')
  assert.ok(!/an\/absolute\/path/.test(nr), 'and the ranked string carries the class, not the path')
  assert.ok(run.report.includes('/an/absolute/path'), 'while the reader is still told which path was ambiguous')
})
