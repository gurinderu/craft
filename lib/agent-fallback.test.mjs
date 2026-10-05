// Direct tests of lib/agent-fallback.mjs (the engine-level cases are in audit-agent-fallback.test.mjs):
// what the "Reviewer agent unavailable" section carries for each kind of fallback, and when it says
// nothing. The sentences themselves are not pinned (realm @nick/craft, #146) — what each must carry is.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { agentUnavailableSection } from './agent-fallback.mjs'

const HEAD = /^## ⚠️ Reviewer agent unavailable\n/
const INSTALL = '/plugin install craft@craft'

test('nothing to say for absent lists, or for emptied entries that emptied nothing', () => {
  const none = /** @type {{ agent: string, count: number, what: string }[]} */ (/** @type {unknown} */ (undefined))
  assert.equal(agentUnavailableSection(none, none), '')
  const holes = /** @type {{ agent: string, count: number, what: string }[]} */ (/** @type {unknown} */ ([null, { agent: 'a', count: 0, what: 'x' }]))
  assert.equal(agentUnavailableSection([], holes), '')
})

test('an unregistered agent gets one line each, its error quoted and bounded, and the install line', () => {
  const error = `not found: ${'e'.repeat(200)}`
  const out = agentUnavailableSection([{ agent: 'craft:a', what: 'every rust lens', error }, { agent: 'craft:b', what: 'the dims' }], [])
  assert.match(out, HEAD)
  const lines = out.split('\n').filter(l => l.startsWith('- '))
  assert.equal(lines.length, 2)
  assert.ok(lines[0]?.includes('`craft:a`') && lines[0].includes('every rust lens'), lines[0])
  assert.ok(lines[0]?.includes(error.slice(0, 160)) && !lines[0].includes(error.slice(0, 161)), 'the error is quoted up to 160 characters')
  assert.ok(lines[1]?.includes('`craft:b`') && lines[1].includes('the dims'), lines[1])
  assert.ok(out.includes(INSTALL))
})

test('an emptied or unrecognised failure is one line each, with its count and bounded error, and no install line', () => {
  const error = `x${'e'.repeat(200)}`
  const out = agentUnavailableSection([], [{ agent: 'craft:a', count: 2, what: 'lenses', error }, { agent: 'craft:b', count: 1, what: 'dims' }])
  assert.match(out, HEAD)
  const lines = out.split('\n').filter(l => l.startsWith('- '))
  assert.equal(lines.length, 2)
  assert.ok(lines[0]?.includes('`craft:a`') && lines[0].includes('2 lenses'), lines[0])
  assert.ok(lines[0]?.includes(error.slice(0, 160)) && !lines[0].includes(error.slice(0, 161)), 'the error is quoted up to 160 characters')
  assert.ok(lines[1]?.includes('`craft:b`') && lines[1].includes('1 dims'), lines[1])
  assert.ok(!out.includes(INSTALL))
})
