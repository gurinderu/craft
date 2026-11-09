// A dispatch round in which every agent died is the stop, executed end to end (realm @nick/craft, nodes
// #299, #300). Under an account limit the Workflow tool's agent() resolves null with no text, so the limit
// read never fires; a run that kept dispatching into it spent 267-360 dead agents. Here every agent dies
// from the lens phase on, as the live runs did: the round runs its whole ladder, and then nothing more.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'

const DEATHS_NOTE = /^stopped: every agent dispatched in [^\n]+ died with no answer, most likely the account's usage limit or a failure \(the reason shows in the Workflow tool's failures list\)/

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
