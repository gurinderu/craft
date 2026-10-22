// The consumer's own agents as extra lenses of craft:review (realm @nick/craft, node #295), driven through
// the whole engine: named or discovered, dispatched on their own agent type with the diff range, their
// findings verified with the rest; an unknown or dead one is a coverage gap, never a failed run.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'

const EXTRA = { severity: 'Medium', title: 'extra finds this', file: 'src/lib.rs', line: 7, why: 'w', fix: 'f', source: 'x', ruleId: '', whereChecked: '' }
const VOTE = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'holds' }
const AGENTS = [
  { name: 'code-critic', description: 'Reads the diff of a PR and reviews it for defects.', tools: 'Read, Grep, Bash' },
  { name: 'fixer', description: 'Reviews findings and applies fixes to the code.', tools: '' },
  { name: 'docs-writer', description: 'Writes documentation.', tools: '' },
]

/** @param {Record<string, any>} [extra] @returns {Record<string, any>} */
function script(extra = {}) {
  return {
    detect: { baseRef: 'main', files: ['src/lib.rs'], spec: '', branch: 'feat/x', head: 'abc1234' },
    'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
    checkpoint: { runDir: '/store/.partial/run-A', error: '' },
    'log-run': { ok: true, error: '' },
    scout: { sizeBucket: 'small', lenses: ['safety'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
    gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
    lens: { lens: 'x', findings: [] },
    dedup: { groups: [] },
    'verify-batch': { verdicts: [{ index: 0, ...VOTE }] },
    'extra-lens-discovery': { agents: AGENTS },
    'extra-lens': (/** @type {{ opts: any }} */ { opts }) => {
      if (opts.agentType === 'ghost') throw new Error("agent type 'ghost' not found")
      return { lens: opts.agentType, findings: [EXTRA] }
    },
    synthesis: null,
    '*': null,
    ...extra,
  }
}

/** @param {import('./engine-harness.mjs').Call[]} calls */
const extraCalls = calls => calls.filter(c => c.key === 'extra-lens')

test('named: the agent runs on its own type with the diff range, and its finding is verified into the verdict', async () => {
  const run = await runEngine('review', { args: { extraLenses: ['reviewer'] }, script: script() })
  assert.ok(!run.calls.some(c => c.key === 'extra-lens-discovery'), 'a named list is not discovered')
  const [call, more] = extraCalls(run.calls)
  assert.ok(call && !more, 'dispatched once')
  assert.equal(call.opts.agentType, 'reviewer')
  assert.match(call.prompt, /git diff --merge-base 'main'/, 'the prompt carries the diff range')
  assert.ok(run.calls.some(c => c.key === 'verify-batch'), 'its Medium went through verification')
  assert.match(run.report, /## Confirmed\n- Medium[^\n]*extra finds this/)
  assert.match(run.report, /## Extra lenses\nChosen: named by the caller[^\n]*\nRan: reviewer\./)
  const record = filedRecord(run)
  assert.deepEqual(record.extraLenses, { how: 'named', requested: ['reviewer'], ran: ['reviewer'], failed: [] })
})

test('a named agent that does not exist is a coverage gap; the run completes with the others', async () => {
  const run = await runEngine('review', { args: { extraLenses: ['ghost', 'reviewer'], depth: 'light' }, script: script() })
  assert.match(run.report, /coverage gap: ghost -- the agent type is not registered/)
  assert.match(run.report, /INCOMPLETE[^\n]*extra lens ghost/, 'the verdict names the gap')
  assert.match(run.report, /extra finds this/, 'the agent that exists still contributed')
  assert.deepEqual(filedRecord(run).extraLenses.failed, [{ agent: 'ghost', why: 'the agent type is not registered in this session' }])
})

test('discovered: a reviewer under another name is found, an editing agent skipped', async () => {
  const run = await runEngine('review', { args: {}, script: script() })
  assert.ok(run.calls.some(c => c.key === 'extra-lens-discovery'), 'discovery ran')
  assert.deepEqual(extraCalls(run.calls).map(c => c.opts.agentType), ['code-critic'])
  assert.match(run.report, /Chosen: discovered among the repository's own agents\.\nRan: code-critic\./)
  assert.equal(filedRecord(run).extraLenses.how, 'discovered')
})

test('discovered: none found, or the listing dead, leaves the craft lenses alone and says so', async () => {
  const none = await runEngine('review', { args: {}, script: script({ 'extra-lens-discovery': { agents: [AGENTS[1], AGENTS[2]] } }) })
  assert.equal(extraCalls(none.calls).length, 0)
  assert.match(none.report, /No repo reviewer found: 2 agent definition\(s\) read/)
  const dead = await runEngine('review', { args: {}, script: script({ 'extra-lens-discovery': null }) })
  assert.match(dead.report, /No repo reviewer found: the agent listing[^\n]*did not answer/)
  assert.doesNotMatch(dead.report, /INCOMPLETE/, 'no extra lens is not a coverage gap')
})

test('an empty list turns the extra lenses off: no discovery, no section', async () => {
  const run = await runEngine('review', { args: { extraLenses: [] }, script: script() })
  assert.ok(!run.calls.some(c => c.key === 'extra-lens-discovery' || c.key === 'extra-lens'))
  assert.doesNotMatch(run.report, /## Extra lenses/)
  assert.equal(filedRecord(run).extraLenses.how, 'off')
})
