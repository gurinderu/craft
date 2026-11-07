// craft:review's light profile (realm @nick/craft, node #295), driven through the whole engine: one round
// of the diff-scoped lenses, Medium and above verified, the report and the record saying what kind of pass
// it was. The full profile, by default and by name, dispatches exactly what it did before.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'

const SCOUT = { sizeBucket: 'large', lenses: ['safety', 'errors', 'intent', 'compat'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' }
const MEDIUM = { severity: 'Medium', title: 'medium one', file: 'src/lib.rs', line: 3, why: 'w', fix: 'f', source: 'safety', ruleId: '', whereChecked: '' }
// A Low citing a blocking rule: the full profile buys it a verifier (the mislabel hatch), the light one does not.
const LOW = { severity: 'Low', title: 'low one', file: 'src/lib.rs', line: 9, why: 'w', fix: 'f', source: 'errors', ruleId: 'SAF-001', whereChecked: '' }
const VOTE = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'holds' }

/** @param {string[]} [files] @param {Record<string, any>} [scout] @returns {Record<string, any>} */
function script(files = ['src/lib.rs'], scout = SCOUT) {
  return {
    detect: { baseRef: 'main', files, spec: '', branch: 'feat/x', head: 'abc1234' },
    'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
    checkpoint: { runDir: '/store/.partial/run-A', error: '' },
    'log-run': { ok: true, output: ['wrote r.json'] },
    scout,
    gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
    // The first dispatch of each lens finds; every later one is dry.
    lens: (/** @type {{ opts: any }} */ { opts: o }) => {
      const l = String(o.label)
      if (!/ r1\b/.test(l)) return { lens: 'x', findings: [] }
      return { lens: 'x', findings: l.includes(':safety') ? [MEDIUM] : l.includes(':errors') ? [LOW] : [] }
    },
    dedup: { groups: [] },
    'verify-batch': { verdicts: [{ index: 0, ...VOTE }] },
    verify: VOTE,
    critic: { missingLenses: [], notes: 'coverage complete' },
    'extra-lens-discovery': { agents: [] },
    synthesis: null,
    '*': null,
  }
}

/** @param {import('./engine-harness.mjs').Call[]} calls */
const lensLabels = calls => calls.filter(c => c.key === 'lens').map(c => String(c.opts?.label))

test('light: only the diff-scoped lenses, one round, no critic, no verifier for a Low, a verifier for a Medium', async () => {
  const run = await runEngine('review', { args: { depth: 'light' }, script: script() })
  const labels = lensLabels(run.calls)
  for (const l of ['safety', 'errors', 'intent', 'tests']) assert.ok(labels.some(x => x.includes(`:${l} r1`)), `${l} ran`)
  for (const l of ['compat', 'negative-space', 'invariants', 'failure-windows']) assert.ok(!labels.some(x => x.includes(`:${l}`)), `${l} did not run`)
  assert.ok(!labels.some(x => / r2\b/.test(x)), 'no second round')
  assert.ok(!run.calls.some(c => c.key === 'critic'), 'no completeness critic')
  assert.ok(run.calls.some(c => c.key === 'verify-batch' && /src\/lib\.rs/.test(String(c.opts?.label))), 'the Medium was verified')
  assert.ok(!run.calls.some(c => c.key === 'verify'), 'the Low (even citing SAF-001) got no verifier')
  assert.match(run.report, /## Verdict\n[^\n]*light pass \(depth=light\)/, 'the verdict line says light pass')
  assert.match(run.report, /## Light pass -- what it skipped[^\n]*\n[^\n]*compat, negative-space were NOT dispatched/)
  assert.match(run.report, /low one[^\n]*NOT VERIFIED: light pass/)
  const record = filedRecord(run)
  assert.equal(record.depth, 'light')
  assert.deepEqual(record.scout[0].lenses, ['safety', 'errors', 'intent', 'tests'])
  assert.equal(record.scout[0].maxRounds, 1)
})

test('full: by default and by name, the same lenses and rounds as before, the critic and the Low hatch kept', async () => {
  const byDefault = await runEngine('review', { args: {}, script: script() })
  const byName = await runEngine('review', { args: { depth: 'full' }, script: script() })
  assert.deepEqual(lensLabels(byName.calls), lensLabels(byDefault.calls))
  const labels = lensLabels(byDefault.calls)
  for (const l of ['safety', 'errors', 'intent', 'compat']) assert.ok(labels.some(x => x.includes(`:${l} r1`)), `${l} ran`)
  assert.ok(labels.some(x => / r2\b/.test(x)), 'the loop went on to round 2')
  assert.ok(byDefault.calls.some(c => c.key === 'critic'), 'the critic ran')
  assert.ok(byDefault.calls.some(c => c.key === 'verify'), 'the Low citing SAF-001 got its verifier')
  assert.doesNotMatch(byDefault.report, /light pass/i)
  assert.equal(filedRecord(byDefault).depth, 'full')
  assert.equal(filedRecord(byDefault).scout[0].maxRounds, 3)
})

test('an unknown depth runs the full review and says so in the log', async () => {
  const run = await runEngine('review', { args: { depth: 'quick' }, script: script() })
  assert.ok(lensLabels(run.calls).some(x => x.includes(':intent')), 'intent ran: the full plan')
  assert.equal(filedRecord(run).depth, 'full')
  assert.ok(run.logs.some((/** @type {string} */ l) => /depth="quick" is not a depth/.test(l)))
})

test('light on a diff that changes only tests forces neither tests nor intent', async () => {
  const run = await runEngine('review', { args: { depth: 'light' }, script: script(['tests/it.rs']) })
  const labels = lensLabels(run.calls)
  assert.ok(labels.some(x => x.includes(':safety r1')), 'the diff-scoped lenses still ran')
  for (const l of ['intent', 'tests', 'compat']) assert.ok(!labels.some(x => x.includes(`:${l}`)), `${l} did not run`)
})

test('full with extraLenses absent runs as before: no discovery agent, no extra-lens section', async () => {
  const run = await runEngine('review', { args: {}, script: script() })
  assert.ok(!run.calls.some(c => c.key === 'extra-lens-discovery' || c.key === 'extra-lens'))
  assert.doesNotMatch(run.report, /## Extra lenses/)
  assert.equal(filedRecord(run).extraLenses.how, 'off')
})

// realm @nick/craft, node #299: on controller code and on a public contract path the light pass keeps
// the whole-diff lenses those diffs are judged by; negative-space and invariants stay out.
test('light on a controller diff (the scout chose reconciler) dispatches reconciler and failure-windows', async () => {
  const run = await runEngine('review', { args: { depth: 'light' }, script: script(['src/controller.rs'], { ...SCOUT, lenses: ['safety', 'reconciler'] }) })
  const labels = lensLabels(run.calls)
  for (const l of ['reconciler', 'failure-windows']) assert.ok(labels.some(x => x.includes(`:${l} r1`)), `${l} ran`)
  for (const l of ['compat', 'negative-space', 'invariants']) assert.ok(!labels.some(x => x.includes(`:${l}`)), `${l} did not run`)
  assert.match(run.report, /## Light pass -- what it skipped[^\n]*\n[^\n]*it DID run [^\n]*failure-windows/)
})

test('light on a CRD (contract path) diff dispatches compat', async () => {
  const run = await runEngine('review', { args: { depth: 'light' }, script: script(['src/lib.rs', 'charts/op/crds/widget.yaml'], { ...SCOUT, lenses: ['safety'] }) })
  const labels = lensLabels(run.calls)
  assert.ok(labels.some(x => x.includes(':compat r1')), 'compat ran')
  for (const l of ['failure-windows', 'negative-space', 'invariants']) assert.ok(!labels.some(x => x.includes(`:${l}`)), `${l} did not run`)
  assert.match(run.report, /it DID run [^\n]*compat/)
})

test('full on a controller diff runs the same lenses as before: reconciler and failure-windows over several rounds', async () => {
  const run = await runEngine('review', { args: {}, script: script(['src/controller.rs'], { ...SCOUT, lenses: ['safety', 'reconciler'] }) })
  const labels = lensLabels(run.calls)
  for (const l of ['reconciler', 'failure-windows', 'compat', 'negative-space']) assert.ok(labels.some(x => x.includes(`:${l} r1`)), `${l} ran`)
  assert.doesNotMatch(run.report, /light pass/i)
})
