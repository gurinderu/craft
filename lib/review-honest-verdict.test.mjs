// Never Approve over what did not run, stop at a usage limit, attempt the record (realm @nick/craft,
// nodes #298, #299), executed end to end through the harness for review, adversarial-review and rust-audit.
// The shape in which the Workflow sandbox hands an engine a usage-limit failure (a throw, a text answer,
// or a bare null) is NOT observed: the limit fixtures below throw it or answer it as text, the two
// shapes the engines can read. A bare null is invisible to them, and for it the guarantee is the
// dead-lens path: every lens that did not return makes the verdict INCOMPLETE (the first tests).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'

const LIMIT = "You've hit your weekly limit - resets Oct 24, 5pm (Europe/Berlin)"

const GREEN_DIM = { verdict: 'Approve', summary: 'ok', findings: [], evidence: 'Evidence: ran it' }
/** @param {Record<string, unknown>} o */
const audit = o =>
  runEngine('rust-audit', {
    script: {
      scout: { baseRef: 'main', hasUnsafe: false, crates: [{ name: 'a', path: 'crates/a' }], changedCrates: [], edges: [], repoRoot: '/r', notes: 'n' },
      workflow: '## Verdict\nApprove',
      '*': GREEN_DIM,
      ...o,
    },
  })

test('rust-audit: a synthesized Approve over a dimension that did not run is INCOMPLETE', async () => {
  const run = await audit({ deps: null, synthesis: '**Overall verdict:** Approve\n\n| dim | verdict |' })
  assert.match(run.report, /\*\*Overall verdict:\*\* \S+ INCOMPLETE/, run.report)
  assert.equal(filedRecord(run)?.verdict, 'INCOMPLETE')
})

test('rust-audit: a usage limit skips the synthesis, says so, and still attempts the record', async () => {
  const run = await audit({
    deps: () => {
      throw new Error(LIMIT)
    },
    synthesis: '**Overall verdict:** Approve',
  })
  assert.ok(!run.calls.some(c => c.label === 'synthesis'), 'no synthesis after the stop')
  assert.match(
    run.report,
    /INCOMPLETE \S+ the synthesis did not run[^\n]*stopped: usage limit reached \(You've hit your weekly limit[^\n]*record could not be written \(rust-audit writes no checkpoints\): rerun the audit after the limit resets/,
  )
  const rec = filedRecord(run)
  assert.equal(rec?.verdict, 'INCOMPLETE')
  assert.match(String(rec?.notRun[0]), /^stopped: usage limit reached/)
})

test("rust-audit: a usage limit answered as a dimension's text is the same stop", async () => {
  const run = await audit({ deps: LIMIT, synthesis: '**Overall verdict:** Approve' })
  assert.ok(!run.calls.some(c => c.label === 'synthesis'), 'no synthesis after the stop')
  assert.equal(filedRecord(run)?.verdict, 'INCOMPLETE')
})

test('rust-audit: a usage limit thrown at the synthesis is a stop report, INCOMPLETE, and the record is attempted', async () => {
  const run = await audit({
    synthesis: () => {
      throw new Error(LIMIT)
    },
  })
  assert.match(run.report, /INCOMPLETE \S+ the synthesis did not run[^\n]*stopped: usage limit reached/)
  assert.ok(
    run.calls.some(c => /^log-run/.test(c.label)),
    'the record write is dispatched',
  )
  const rec = filedRecord(run)
  assert.equal(rec?.verdict, 'INCOMPLETE')
  assert.match(String(rec?.notRun[0]), /^stopped: usage limit reached/)
})

test('rust-audit: a nested review that reports its own usage-limit stop stops the audit', async () => {
  const nested = `## \u26d4 Usage limit reached\nstopped: usage limit reached (${LIMIT}). The run record was attempted\n\n## Verdict\n\u26a0\ufe0f INCOMPLETE \u2014 x`
  const run = await audit({ workflow: nested, synthesis: '**Overall verdict:** Approve' })
  assert.ok(!run.calls.some(c => c.label === 'synthesis'), 'no synthesis after the nested stop')
  const rec = filedRecord(run)
  assert.match(String(rec?.verdict), /INCOMPLETE/, 'never green: the stopped nested review rolls up non-green and the audit is marked')
  assert.equal(String(rec?.notRun[0]), `stopped: usage limit reached (${LIMIT})`)
})

test('rust-audit: no nested review launches once the stop is seen', async () => {
  const run = await audit({
    scout: () => {
      throw new Error(LIMIT)
    },
  })
  assert.ok(!run.calls.some(c => c.label === 'workflow'), 'no nested review after a limit at the scout')
  assert.ok(
    run.calls.some(c => /^log-run/.test(c.label)),
    'the record write is still dispatched',
  )
})
