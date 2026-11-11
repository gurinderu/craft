// The review tool's child sessions as the plugin hands them to the driver: nested under the caller, on the caller's
// model unless the review's table chose one, and marked as the review's own sessions.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { ENGINE_SESSIONS } from './orchestrator.ts'
import { TOOLS, nestedUnder, reviewChild } from './tools.ts'

/** @returns {import('./host.ts').Host & { asked: import('./host.ts').ChildRequest[] }} */
function fakeHost() {
  /** @type {import('./host.ts').ChildRequest[]} */
  const asked = []
  return {
    asked, directory: '/r', worktree: '/r', sh: async () => '', callerModel: async () => undefined,
    runChild: async req => { asked.push(req); req.onSession?.('ses_child'); return 'done' },
  }
}

test('a review task nests under the caller and takes its model unless the table chose one', async () => {
  const host = fakeHost()
  const caller = { providerID: 'p', modelID: 'caller' }
  const child = reviewChild(host, 'ses_caller', caller)
  await child({ title: 't', agent: 'review-task', prompt: 'x' })
  await child({ title: 't', agent: 'review-task', prompt: 'x', model: { providerID: 'p', modelID: 'mapped' } })
  assert.deepEqual(host.asked.map(r => [r.parentID, r.model?.modelID]), [['ses_caller', 'caller'], ['ses_caller', 'mapped']])
  assert.ok(ENGINE_SESSIONS.has('ses_child'), 'the work hook stays silent in it')
})

test('without a caller the child is top-level on the runtime default', async () => {
  const host = fakeHost()
  await reviewChild(host, undefined, undefined)({ title: 't', agent: 'review-task', prompt: 'x' })
  assert.deepEqual([host.asked[0]?.parentID, host.asked[0]?.model], [undefined, undefined])
})

test('the plugin offers the review beside the audit and the triage', () => {
  assert.deepEqual(TOOLS.map(t => t.name), ['rust-audit', 'triage-findings', 'review'])
})

test('the audit and the triage nest their children under the caller too, and keep the rest of the host', async () => {
  const host = fakeHost()
  const nested = nestedUnder(host, 'ses_caller')
  await nested.runChild({ title: 't', agent: 'rust-reviewer', prompt: 'x' })
  assert.equal(host.asked[0]?.parentID, 'ses_caller')
  assert.equal(nested.directory, '/r')
  assert.equal(nestedUnder(host, undefined), host, 'no caller: the host as it is')
})
