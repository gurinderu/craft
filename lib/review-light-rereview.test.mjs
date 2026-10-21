// The light re-review after fixes (skills/addressing-findings, step 7; realm @nick/craft, node #12): with the commit
// the addressed review was made on as `base` and `fresh`, craft:review's lenses diff exactly base...HEAD, the fix
// commits, even when an older run on the branch could be chained to. Without `fresh` it chains to that run's head.
// Executed through the engine harness: the lens prompts carry the diff range each lens is told to run.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'

const REVIEWED = 'abc1111'
const OLD_RUN = 'def0000'
const PRIOR = { found: true, round: 2, head: OLD_RUN, ledger: [], ledgerCount: 0, priorFindings: 0, reason: '', sameFpBasis: true }
const NONE = { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' }

/** @param {any} priorRound */
const reviewScript = priorRound => ({
  detect: { baseRef: REVIEWED, files: ['src/lib.rs'], spec: '', branch: 'feat/x', head: 'abc9999', baseIsHead: false, notes: '' },
  'prior-round': priorRound,
  checkpoint: { runDir: '/store/.partial/run-A', error: '' },
  'log-run': { ok: true, error: '' },
  scout: { sizeBucket: 'small', lenses: ['safety'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
  gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
  lens: { lens: 'safety', findings: [] },
  dedup: { groups: [] },
  synthesis: null,
  '*': null,
})

/** The lens dispatches' prompts. @param {import('./engine-harness.mjs').Call[]} calls */
const lensPrompts = calls => {
  const lenses = calls.filter(c => /^lens/.test(String(c.label))).map(c => c.prompt)
  assert.ok(lenses.length > 0, 'a lens must run, or nothing was observed')
  return lenses
}

/** @param {any} args @param {any} priorRound */
async function lensesOf(args, priorRound) {
  const { calls } = await runEngine('review', { args, script: reviewScript(priorRound) })
  const detect = calls.find(c => c.label === 'detect')
  assert.match(String(detect?.prompt), new RegExp(`Use \`${REVIEWED}\`\\.`), 'the base reaches the base resolver as given')
  return { calls, lenses: lensPrompts(calls) }
}

test('light re-review: base + fresh with no earlier run, the lenses diff base...HEAD', async () => {
  const { lenses } = await lensesOf({ base: REVIEWED, fresh: true, fullEvery: 0 }, NONE)
  for (const p of lenses) assert.match(p, new RegExp(`git diff --merge-base '${REVIEWED}'`))
})

test('light re-review: base + fresh ignores an older run on the branch, the lenses still diff base...HEAD', async () => {
  const { calls, lenses } = await lensesOf({ base: REVIEWED, fresh: true, fullEvery: 0 }, PRIOR)
  assert.ok(!calls.some(c => c.label === 'prior-round'), 'fresh never reads the round chain')
  for (const p of lenses) {
    assert.match(p, new RegExp(`git diff --merge-base '${REVIEWED}'`))
    assert.doesNotMatch(p, new RegExp(OLD_RUN))
  }
})

test('without fresh, an older run on the branch is chained to: the lenses diff from its head, not from base', async () => {
  const { lenses } = await lensesOf({ base: REVIEWED, fullEvery: 0 }, PRIOR)
  for (const p of lenses) assert.match(p, new RegExp(`git diff --merge-base '${OLD_RUN}'`))
})

test('adversarial-review: diffBase is the base the scout and every review lens are told to use', async () => {
  const script = {
    scout: { baseRef: REVIEWED, sizeBucket: 'small', lenses: ['correctness'], changedFiles: ['src/lib.rs'], notes: 'x' },
    'index-warmup': { indexed: false, notes: 'x' }, review: { findings: [] }, 'coverage-critic': { findings: [] }, 'log-run': { ok: true }, '*': null,
  }
  const { calls } = await runEngine('adversarial-review', { args: { diffBase: REVIEWED }, script })
  assert.match(String(calls.find(c => c.label === 'scout')?.prompt), new RegExp(`Use \`${REVIEWED}\`\\.`))
  const reviews = calls.filter(c => /^review/.test(String(c.label)))
  assert.ok(reviews.length > 0, 'a review lens must run, or nothing was observed')
  for (const c of reviews) assert.match(c.prompt, new RegExp(`\`${REVIEWED}\``))
})
