// Direct tests of lib/agent-fallback.mjs (the engine-level cases are in audit-agent-fallback.test.mjs):
// what the "Reviewer agent unavailable" section says for each kind of fallback, and when it says nothing.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { agentUnavailableSection } from './agent-fallback.mjs'

const HEAD = '## ⚠️ Reviewer agent unavailable\n'
const FIX = 'Enable the plugin in this project (`/plugin install craft@craft`, project or local scope) and re-run to use it.\n'

test('nothing to say for absent lists, or for emptied entries that emptied nothing', () => {
  const none = /** @type {{ agent: string, count: number, what: string }[]} */ (/** @type {unknown} */ (undefined))
  assert.equal(agentUnavailableSection(none, none), '')
  const holes = /** @type {{ agent: string, count: number, what: string }[]} */ (/** @type {unknown} */ ([null, { agent: 'a', count: 0, what: 'x' }]))
  assert.equal(agentUnavailableSection([], holes), '')
})

test('an unregistered agent gets the install line, its error quoted and bounded', () => {
  const error = `not found: ${'e'.repeat(200)}`
  const out = agentUnavailableSection([{ agent: 'craft:a', what: 'every rust lens', error }, { agent: 'craft:b', what: 'the dims' }], [])
  assert.equal(out, `${HEAD}${[
    `- \`craft:a\` is not registered in this session, so every rust lens went to the generic subagent, without that agent's rubric — this run is weaker than a normal one, not broken. (${error.slice(0, 160)})`,
    '- `craft:b` is not registered in this session, so the dims went to the generic subagent, without that agent\'s rubric — this run is weaker than a normal one, not broken.',
  ].join('\n')}\n${FIX}\n`)
})

test('an emptied or unrecognised failure is said softly, without the install line', () => {
  const error = `x${'e'.repeat(200)}`
  const out = agentUnavailableSection([], [{ agent: 'craft:a', count: 2, what: 'lenses', error }, { agent: 'craft:b', count: 1, what: 'dims' }])
  assert.equal(out, `${HEAD}${[
    `- \`craft:a\` failed with "${error.slice(0, 160)}" on 2 lenses, which were re-run on the generic subagent, without its rubric (an unregistered agent in wording this engine does not recognise, or a missing model or tool).`,
    '- `craft:b` returned nothing for 1 dims, which were re-run on the generic subagent, without its rubric (an unregistered agent on some runtimes, or a transient failure).',
  ].join('\n')}\n\n`)
})
