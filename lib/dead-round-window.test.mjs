// What deaths must NOT stop (realm @nick/craft, node #299): a round with even one live answer. A dead agent
// comes back in seconds and a live lens in minutes, so in a sliding window most of a round's queue can die
// before its first live answer; a numbered streak stopped such a run with 4 of 5 slices dying while one
// answered, and the answering slice's findings were never verified. A deadline fire is not a death, and
// a nested review that died or stopped on deaths is one dead agent of its parent's round, not a stop.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'

const BASE = {
  'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
  'log-run': { ok: true, output: ['wrote r.json'] },
  checkpoint: { runDir: '/store/.partial/run-A', error: '' },
  gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
  dedup: { groups: [] },
  synthesis: '## Verdict\n✅ Approve — clean.\n',
  '*': null,
}
const CONFIRMS = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'stands' }
const MEDIUM = { title: 'unchecked vm state', file: 'bin/api/src/vm.rs', line: 3, severity: 'Medium', why: 'w', fix: 'f', ruleId: '' }
const scout = (/** @type {string[]} */ lenses) => ({ sizeBucket: 'medium', lenses, isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' })
// Fourteen Rust files over five directories: the code-intrinsic lenses are sliced five ways.
const FILES = ['bin/api/src/vm.rs', 'bin/api/src/error.rs', 'bin/api/src/admission.rs',
  'bin/ctl/src/sg/mod.rs', 'bin/ctl/src/sg/ovn.rs', 'bin/ctl/src/sg/provision.rs', 'bin/ctl/src/sg/tests.rs',
  'bin/ctl/src/vm/provision.rs', 'bin/ctl/src/vm/delete.rs', 'bin/ctl/src/vm/context.rs',
  'crates/k8s/src/lib.rs', 'crates/k8s/src/sg.rs', 'crates/model/src/vm.rs', 'crates/model/src/lib.rs']
/** @param {{ opts: { label?: string } }} c */
const labelOf = c => String(c.opts.label)

test('review: 4 of 5 slices dying ahead of the one that answers is not a stop, and its findings are verified', async () => {
  let deaths = 0
  let deathsBeforeLive = -1
  const run = await runEngine('review', {
    script: {
      ...BASE,
      detect: { baseRef: 'main', files: FILES, spec: '', branch: 'feat/x', head: 'abc1234' },
      scout: scout(['safety', 'errors', 'concurrency', 'maintainability', 'tests', 'reconciler']),
      // Only the bin/api slice answers, and later; every other slice dies at once. An unsliced dispatch
      // (a whole-diff lens, a resurrection) answers too, later.
      lens: (/** @type {{ opts: { label?: string } }} */ c) => lensAnswer(c),
      retry: (/** @type {{ opts: { label?: string } }} */ c) => (/^retry:lens:/.test(labelOf(c)) ? lensAnswer(c) : null),
      'verify-batch': (/** @type {{ prompt: string }} */ { prompt }) => ({
        verdicts: [...prompt.matchAll(/--- FINDING (\d+) ---/g)].map(m => ({ index: Number(m[1]), ...CONFIRMS })),
      }),
    },
  })
  /** @param {{ opts: { label?: string } }} c */
  function lensAnswer(c) {
    const label = labelOf(c)
    if (/ r\d+ (?!bin\/api$)\S+$/.test(label)) { deaths++; return null }
    return new Promise(resolve => setTimeout(() => {
      if (deathsBeforeLive < 0) deathsBeforeLive = deaths
      resolve({ lens: 'x', findings: /:safety r1 bin\/api$/.test(label) ? [MEDIUM] : [] })
    }, 20))
  }
  assert.ok(run.logs.some(l => /diff sliced into 5 scope/.test(l)), 'premise: the diff is sliced')
  // The rejected streak stopped at 65 deaths in a row (realm @nick/craft, node #299).
  assert.ok(deathsBeforeLive > 65, `premise: ${deathsBeforeLive} deaths settled before the first live answer`)
  assert.doesNotMatch(run.report, /died with no answer/)
  assert.ok(run.calls.some(c => /^verify-batch:bin\/api\/src\/vm\.rs/.test(c.label) && c.result != null), 'the live slice\'s finding is verified')
  assert.ok(run.logs.some(l => /\[rust\] Verify: 1 confirmed/.test(l)), 'and confirmed')
  assert.ok(run.calls.some(c => c.label === 'synthesis'), 'the synthesis runs')
})

test('review: lenses that time out on the deadline are not deaths and stop nothing', async () => {
  const run = await runEngine('review', {
    args: { deadlineMs: 50 },
    script: { ...BASE, detect: { baseRef: 'main', files: ['src/lib.rs'], spec: '', branch: 'feat/x', head: 'abc1234' }, scout: scout(['safety', 'errors']), lens: () => new Promise(() => {}) },
  })
  assert.ok(run.logs.some(l => /exhausted its .* budget with no response/.test(l)), 'premise: the deadline fired')
  assert.doesNotMatch(run.report, /died with no answer/)
  assert.ok(run.calls.some(c => / resurrect\d/.test(c.label)), 'the resurrection sweep still runs')
})

test('review: one lens that keeps dying is a dead lens, not a stop', async () => {
  const LOW = { ...MEDIUM, severity: 'Low' }
  const run = await runEngine('review', {
    script: {
      ...BASE,
      detect: { baseRef: 'main', files: ['src/lib.rs'], spec: '', branch: 'feat/x', head: 'abc1234' },
      scout: scout(['safety', 'errors', 'tests']),
      lens: (/** @type {{ opts: { label?: string } }} */ c) => (/:tests /.test(labelOf(c)) ? null : { lens: 'x', findings: /:safety /.test(labelOf(c)) ? [LOW] : [] }),
    },
  })
  assert.ok(run.calls.filter(c => /^(retry:)?lens:rust:tests /.test(c.label)).length >= 4, 'premise: the dead lens spent its ladder')
  assert.doesNotMatch(run.report, /died with no answer/)
  assert.ok(run.calls.some(c => c.label === 'synthesis'), 'the synthesis still runs')
  assert.match(run.report, /INCOMPLETE/, 'and the dead lens makes the verdict INCOMPLETE')
})

test('adversarial-review: a verification pass with one live verifier is not a stop', async () => {
  const findings = Array.from({ length: 30 }, (_unused, i) => ({ title: `bug ${i}`, file: `src/f${i}.rs`, line: 3, severity: 'Medium', why: 'w', fix: 'f', category: 'correctness', confidence: 0.9 }))
  const run = await runEngine('adversarial-review', {
    script: {
      scout: { baseRef: 'main', sizeBucket: 'large', lenses: ['correctness', 'security'], changedFiles: ['src/lib.rs'], notes: 'x' },
      'index-warmup': { indexed: false, notes: 'x' },
      review: (/** @type {{ opts: { label?: string } }} */ c) => ({ findings: /correctness/.test(labelOf(c)) ? findings : [] }),
      // Only the last check's verifiers answer, after every other one died.
      verify: (/** @type {{ opts: { label?: string } }} */ c) => (/src\/f29\.rs/.test(labelOf(c)) ? new Promise(r => setTimeout(() => r({ refuted: false, premiseSupported: true, reasoning: 'r', severity: 'medium' }), 20)) : null),
      'coverage-critic': { findings: [] },
      'log-run': { ok: true },
      '*': null,
    },
  })
  assert.ok(run.calls.some(c => /^verify:/.test(c.label) && c.result != null), 'premise: one verifier answered')
  assert.ok(run.calls.some(c => /^coverage-critic/.test(c.label)), 'the critic runs')
  assert.ok(!run.reportValue.notRun.some((/** @type {string} */ n) => /died with no answer/.test(n)), run.reportValue.notRun.join('\n'))
})

/** A rust-audit over `n` changed crates whose other dimensions all answer, nested reviews answered by `nested`. @param {number} n @param {(i: number) => unknown} nested */
function auditOverCrates(n, nested) {
  const crates = Array.from({ length: n }, (_unused, i) => ({ name: `c${i}`, path: `crates/c${i}` }))
  return runEngine('rust-audit', {
    script: {
      scout: { baseRef: 'main', hasUnsafe: false, crates, changedCrates: crates, edges: [], repoRoot: '/r', notes: 'n' },
      workflow: (/** @type {{ argv: any[] }} */ { argv }) => nested(Number(/crates\/c(\d+)/.exec(String(argv[1]?.path))?.[1])),
      synthesis: '**Overall verdict:** Approve',
      '*': { verdict: 'Approve', summary: 'ok', findings: [], evidence: 'Evidence: ran it' },
    },
  })
}

test('rust-audit: nested reviews that died or stopped on deaths beside live dimensions are dead dimensions, not a stop', async () => {
  const stopped = '## ⛔ Agents died without an answer\nstopped: every agent dispatched in [rust] lens round 1 died with no answer, most likely the account\'s usage limit or a failure (the reason shows in the Workflow tool\'s failures list). The run record was attempted\n\n## Verdict\n⚠️ INCOMPLETE — x'
  const run = await auditOverCrates(4, i => (i % 2 ? null : stopped))
  assert.doesNotMatch(run.report, /the synthesis did not run/)
  assert.ok(run.calls.some(c => c.label === 'synthesis'), 'the synthesis runs')
})
