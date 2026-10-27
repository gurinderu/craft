// What the death streak must NOT stop, and what it counts (realm @nick/craft, nodes #299, #300). Deaths are
// counted in completion order, and a dead agent comes back in seconds where a live lens takes minutes:
// slices that die every time settle their whole ladder ahead of their live siblings, and that is a few
// dead slices, not a dead account. Bookkeeping writes are not review work and count for nothing; a
// nested review in rust-audit is one agent to its parent, dead or live.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'
import { DEATH_STREAK_STOP } from './usage-limit.mjs'

const BASE = {
  'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
  'log-run': { ok: true, error: '' },
  gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
  dedup: { groups: [] },
  synthesis: '## Verdict\n✅ Approve — clean.\n',
  '*': null,
}
const LOW = { title: 'a nit', file: 'bin/api/src/vm.rs', line: 3, severity: 'Low', why: 'w', fix: 'f', ruleId: '' }
const scout = (/** @type {string[]} */ lenses) => ({ sizeBucket: 'medium', lenses, isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' })
// Fourteen Rust files over five directories: the code-intrinsic lenses are sliced five ways.
const FILES = ['bin/api/src/vm.rs', 'bin/api/src/error.rs', 'bin/api/src/admission.rs',
  'bin/ctl/src/sg/mod.rs', 'bin/ctl/src/sg/ovn.rs', 'bin/ctl/src/sg/provision.rs', 'bin/ctl/src/sg/tests.rs',
  'bin/ctl/src/vm/provision.rs', 'bin/ctl/src/vm/delete.rs', 'bin/ctl/src/vm/context.rs',
  'crates/k8s/src/lib.rs', 'crates/k8s/src/sg.rs', 'crates/model/src/vm.rs', 'crates/model/src/lib.rs']

test('review: slices that die every time and settle ahead of slow live siblings are not a stop', async () => {
  let deaths = 0
  let deathsBeforeLive = -1
  const run = await runEngine('review', {
    script: {
      ...BASE,
      detect: { baseRef: 'main', files: FILES, spec: '', branch: 'feat/x', head: 'abc1234' },
      checkpoint: { runDir: '/store/.partial/run-A', error: '' },
      scout: scout(['safety', 'errors', 'concurrency', 'maintainability', 'tests']),
      // Two slices kill every lens sent to them at once; every other dispatch answers, later.
      lens: (/** @type {{ opts: { label?: string } }} */ c) => {
        if (/ crates\/(k8s|model)$/.test(String(c.opts.label))) { deaths++; return null }
        return new Promise(resolve => setTimeout(() => {
          if (deathsBeforeLive < 0) deathsBeforeLive = deaths
          resolve({ lens: 'x', findings: / r1 bin\/api$/.test(String(c.opts.label)) ? [LOW] : [] })
        }, 20))
      },
    },
  })
  assert.ok(run.logs.some(l => /diff sliced into 5 scope/.test(l)), 'premise: the diff is sliced')
  assert.doesNotMatch(run.report, /agents in a row died/)
  assert.ok(deathsBeforeLive > 16, `premise: ${deathsBeforeLive} deaths settled before the first live answer`)
  assert.ok(run.calls.some(c => / resurrect1/.test(c.label)), 'the resurrection sweep runs')
  assert.ok(run.calls.some(c => c.label === 'synthesis'), 'the synthesis runs')
})

test('review: dying bookkeeping writes do not count toward the streak', async () => {
  // Every verifier dies, one short of the stop with the re-dispatches the breaker lets through, and the
  // checkpoints on either side of verification die too: counted, they would carry it over.
  const findings = Array.from({ length: DEATH_STREAK_STOP - 3 }, (_unused, i) => ({ title: `m${i}`, file: `src/f${i}.rs`, line: 3, severity: 'Medium', why: 'w', fix: 'f', ruleId: '' }))
  const run = await runEngine('review', {
    script: {
      ...BASE,
      detect: { baseRef: 'main', files: ['src/lib.rs'], spec: '', branch: 'feat/x', head: 'abc1234' },
      checkpoint: (/** @type {{ opts: { label?: string } }} */ c) => (/rust-plan/.test(String(c.opts.label)) ? { runDir: '/store/.partial/run-A', error: '' } : null),
      scout: scout(['safety', 'errors']),
      lens: (/** @type {{ opts: { label?: string } }} */ c) => ({ lens: 'x', findings: /safety r1/.test(String(c.opts.label)) ? findings : [] }),
    },
  })
  const isBookkeeping = (/** @type {string} */ l) => /^(retry:)?(checkpoint|log-run)/.test(l)
  const tail = run.calls.slice(run.calls.findIndex(c => /^dedup/.test(c.label)) + 1, run.calls.findIndex(c => c.label === 'synthesis'))
  const reviewDeaths = tail.filter(c => !isBookkeeping(c.label) && c.result == null).length
  const bookkeepingDeaths = tail.filter(c => isBookkeeping(c.label) && c.result == null).length
  assert.ok(reviewDeaths < DEATH_STREAK_STOP && reviewDeaths + bookkeepingDeaths >= DEATH_STREAK_STOP,
    `premise: ${reviewDeaths} review deaths, ${bookkeepingDeaths} bookkeeping deaths in a row before the synthesis`)
  assert.doesNotMatch(run.report, /agents in a row died/)
  assert.ok(run.calls.some(c => c.label === 'synthesis' && c.result != null), 'the synthesis runs')
})

/** A rust-audit over `n` changed crates whose other dimensions all die, nested reviews answered by `nested`. @param {number} n @param {(i: number) => unknown} nested */
function auditOverCrates(n, nested) {
  const crates = Array.from({ length: n }, (_unused, i) => ({ name: `c${i}`, path: `crates/c${i}` }))
  return runEngine('rust-audit', {
    script: {
      scout: { baseRef: 'main', hasUnsafe: false, crates, changedCrates: crates, edges: [], repoRoot: '/r', notes: 'n' },
      workflow: (/** @type {{ argv: any[] }} */ { argv }) => nested(Number(/crates\/c(\d+)/.exec(String(argv[1]?.path))?.[1])),
      synthesis: '**Overall verdict:** Approve',
      '*': null,
    },
  })
}

test('rust-audit: a nested review that comes back null is one death toward the streak', async () => {
  const run = await auditOverCrates(DEATH_STREAK_STOP, () => null)
  assert.match(run.report, /INCOMPLETE \S+ the synthesis did not run[^\n]*agents in a row died with no answer/)
  assert.ok(!run.calls.some(c => c.label === 'synthesis'), 'no synthesis after the stop')
})

test('rust-audit: a nested review that answers ends the streak', async () => {
  const live = '## Verdict\n✅ Approve — clean.\n'
  const run = await auditOverCrates(DEATH_STREAK_STOP, i => (i === Math.floor(DEATH_STREAK_STOP / 2) ? live : null))
  assert.doesNotMatch(run.report, /agents in a row died/)
  assert.ok(run.calls.some(c => c.label === 'synthesis'), 'the synthesis runs')
})
