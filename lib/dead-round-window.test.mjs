// What deaths must NOT stop (realm @nick/craft, node #299): a round with even one live answer. A dead agent
// comes back in seconds and a live lens in minutes, so in a sliding window most of a round's queue can die
// before its first live answer; a numbered streak stopped such a run with 4 of 5 slices dying while one
// answered, and the answering slice's findings were never verified. A deadline fire is not a death, and
// a nested review that died or stopped on deaths is one dead agent of its parent's round, not a stop.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'

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
  const stopped =
    "## ⛔ Agents died without an answer\nstopped: every agent dispatched in [rust] lens round 1 died with no answer, most likely the account's usage limit or a failure (the reason shows in the Workflow tool's failures list). The run record was attempted\n\n## Verdict\n⚠️ INCOMPLETE — x"
  const run = await auditOverCrates(4, i => (i % 2 ? null : stopped))
  assert.doesNotMatch(run.report, /the synthesis did not run/)
  assert.ok(
    run.calls.some(c => c.label === 'synthesis'),
    'the synthesis runs',
  )
})
