// Direct tests of lib/agent-fallback.mjs (the engine-level cases are in audit-agent-fallback.test.mjs):
// what the "Reviewer agent unavailable" section carries for each kind of fallback, and when it says
// nothing. The sentences themselves are not pinned (realm @nick/craft, #146) — what each must carry is.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { agentUnavailableSection, agentUnavailableRecord, readAgentUnavailableSection, readAgentUnavailable, isAgentTypeMissing } from './agent-fallback.mjs'

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

// The harness's own words for an unregistered agent type, observed 2026-10-06 by calling the Agent tool
// with `subagent_type: craft:rust-reviewer` in a session where craft was not enabled (realm @nick/craft #152).
const OBSERVED = "Agent type 'craft:rust-reviewer' not found. Available agents: claude, claude-code-guide, Explore, general-purpose, Plan, statusline-setup"

test('the observed harness error for an unregistered agent type is recognised as one', () => {
  assert.equal(isAgentTypeMissing(OBSERVED, 'craft:rust-reviewer'), true)
  assert.equal(isAgentTypeMissing(OBSERVED), true, 'by its wording alone, without the agent name')
})

test('one record shape for both engines: agent types sorted and once, fallbacks summed per agent type', () => {
  assert.deepEqual(agentUnavailableRecord(['craft:b', 'craft:a', 'craft:b'], [
    { agent: 'craft:x', count: 1 }, { agent: 'craft:x', count: 2 }, { agent: 'craft:y', count: 0 },
  ]), { agentUnavailable: ['craft:a', 'craft:b'], agentFallbacks: { 'craft:x': 3 } })
  assert.deepEqual(agentUnavailableRecord([], []), { agentUnavailable: [], agentFallbacks: {} })
})

test('the section reads back into what wrote it, each kind of line', () => {
  const report = `preamble\n${agentUnavailableSection(
    [{ agent: 'craft:a', what: 'every rust lens', error: OBSERVED }],
    [{ agent: 'craft:b', count: 2, what: 'lens dispatch(es)' }, { agent: 'craft:c', count: 3, what: 'lens dispatch(es)', error: 'model m not found' }],
  )}## Verdict\n- not a bullet of the section`
  assert.deepEqual(readAgentUnavailableSection(report), {
    missing: [{ agent: 'craft:a', error: OBSERVED.slice(0, 160) }],
    emptied: [{ agent: 'craft:b', count: 2 }, { agent: 'craft:c', count: 3, error: 'model m not found' }],
  })
  assert.deepEqual(readAgentUnavailableSection('## Verdict\n✅ Approve'), { missing: [], emptied: [] })
  assert.deepEqual(readAgentUnavailableSection(null), { missing: [], emptied: [] })
})

test('a section bullet in wording the reader does not know is read as an unavailable agent, not dropped', () => {
  const long = 'x'.repeat(300)
  const got = readAgentUnavailableSection(`## ⚠️ Reviewer agent unavailable\n- \`craft:z\` was reworded ${long}\n- no agent named here\n`)
  assert.equal(got.missing.length, 2)
  assert.equal(got.missing[0]?.agent, 'craft:z')
  assert.equal(got.missing[0]?.error.length, 160, 'the quoted bullet is bounded at 160 characters')
  assert.equal(got.missing[1]?.agent, 'a craft agent')
})

test('a stored record of either shape and any age reads as the one shape', () => {
  const now = { agentUnavailable: ['craft:rust-reviewer'], agentFallbacks: { 'craft:nix-reviewer': 2 } }
  assert.deepEqual(readAgentUnavailable(now), now)
  assert.deepEqual(readAgentUnavailable({ reviewerAgentUnavailable: ['rust'], reviewerAgentFallbacks: { nix: 2 } }), now,
    'the review engine\'s earlier profile-keyed fields')
  assert.deepEqual(readAgentUnavailable({}), { agentUnavailable: [], agentFallbacks: {} }, 'a record from before either')
  assert.deepEqual(readAgentUnavailable({ agentUnavailable: 'x', agentFallbacks: { a: '1' } }), { agentUnavailable: [], agentFallbacks: {} }, 'malformed fields read as nothing')
  assert.deepEqual(readAgentUnavailable(null), { agentUnavailable: [], agentFallbacks: {} })
})

// A multi-line error (the harness appends "\nAvailable agents: …") must not break the bullet list: the
// reader stops at the first non-bullet line, so an unflattened error dropped every entry after it.
test('a multi-line error round-trips every entry of the section', () => {
  const err = "Agent type 'craft:a' not found.\nAvailable agents: claude,\n  general-purpose\r\n\tExplore"
  const section = agentUnavailableSection(
    [{ agent: 'craft:a', what: 'every rust lens', error: err }],
    [{ agent: 'craft:c', count: 2, what: 'lens dispatch(es)', error: 'model x not found\nretry later' }, { agent: 'craft:b', count: 3, what: 'lens dispatch(es)' }],
  )
  const bullets = section.split('\n').filter(l => l.startsWith('- '))
  assert.equal(bullets.length, 3, 'one line per entry')
  const got = readAgentUnavailableSection(section)
  assert.deepEqual(got.missing.map(x => x.agent), ['craft:a'])
  assert.match(got.missing[0]?.error ?? '', /^Agent type 'craft:a' not found\. Available agents: claude, general-purpose Explore$/)
  assert.deepEqual(got.emptied.map(x => [x.agent, x.count]), [['craft:c', 2], ['craft:b', 3]])
  assert.equal(got.emptied[0]?.error, 'model x not found retry later')
})
