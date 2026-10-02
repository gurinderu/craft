// rust-audit runs its contract/architecture/security/miri dimensions on dedicated craft agents. When one
// is not registered (the plugin not enabled in that project) the dimension runs on the generic subagent;
// the report and the record say so, with the same wording as review (realm @nick/craft #116).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'
import { isAgentTypeMissing, agentUnavailableSection } from './agent-fallback.mjs'

const base = {
  scout: { hasDiff: false, hasUnsafe: false, baseRef: 'main', repoRoot: '/ws', notes: 'x', crates: [], changedCrates: [], edges: [] },
  synthesis: 'AUDIT-REPORT-BODY',
  'log-run': { ok: true },
  '*': null,
}

test('rust-audit: an unregistered architecture agent is named in the report and on the record', async () => {
  const architecture = ({ opts }) => {
    if (opts?.agentType) throw new Error(`agent type '${opts.agentType}' not found`)
    return { findings: [] }
  }
  const run = await runEngine('rust-audit', { args: {}, script: { ...base, architecture } })
  assert.match(run.report, /AUDIT-REPORT-BODY/, 'premise: the audit completed')
  const section = run.report.match(/## ⚠️ Reviewer agent unavailable[\s\S]*?(\n\n|$)/)?.[0] || ''
  assert.match(section, /`craft:rust-architecture-reviewer` is not registered[^\n]*generic subagent[^\n]*rubric/)
  assert.match(run.report, /\/plugin install craft@craft/)
  assert.deepEqual(filedRecord(run)?.agentUnavailable, ['craft:rust-architecture-reviewer'])
})

test('rust-audit: with every agent answering there is no section and nothing recorded', async () => {
  const run = await runEngine('rust-audit', { args: {}, script: { ...base, architecture: { findings: [] }, security: { findings: [] } } })
  assert.ok(!/Reviewer agent unavailable/.test(run.report))
  assert.deepEqual((filedRecord(run) || {}).agentFallbacks, {})
  const rec = filedRecord(run) || {}
  assert.deepEqual(rec.agentUnavailable, [])
})

test('rust-audit: a "not found" that is not about the agent type is not called a missing agent', async () => {
  const architecture = ({ opts }) => {
    if (opts?.agentType) throw new Error('model opus-x not found')
    return { findings: [] }
  }
  const run = await runEngine('rust-audit', { args: {}, script: { ...base, architecture } }).catch(e => ({ report: '', calls: e.calls || [] }))
  assert.ok(!/plugin install/.test(run.report || ''), 'no install line for a missing model')
})

test('shared helpers: the agent-type match and the section wording', () => {
  assert.equal(isAgentTypeMissing("agent type 'craft:x' not found", 'craft:x'), true)
  assert.equal(isAgentTypeMissing('craft:x not found', 'craft:x'), true)
  assert.equal(isAgentTypeMissing('model claude-x not found', 'craft:x'), false)
  assert.equal(isAgentTypeMissing('404 Not Found', 'craft:x'), false)
  assert.equal(agentUnavailableSection([], []), '')
  const soft = agentUnavailableSection([], [{ agent: 'craft:x', count: 2, what: 'dispatch(es)' }])
  assert.match(soft, /returned nothing for 2 dispatch/)
  assert.ok(!/plugin install/.test(soft), 'an empty answer is not a missing plugin')
})

test('rust-audit: a dimension agent that answers with nothing, then the generic subagent answers, is counted and said softly', async () => {
  const security = ({ opts }) => (opts?.agentType ? null : { findings: [] })
  const run = await runEngine('rust-audit', { args: {}, script: { ...base, architecture: { findings: [] }, security } })
  assert.match(run.report, /`craft:rust-security-scanner` returned nothing for 1 dimension dispatch/)
  assert.ok(!/plugin install/.test(run.report))
  assert.deepEqual((filedRecord(run) || {}).agentFallbacks, { 'craft:rust-security-scanner': 1 })
})

test('rust-audit: a dispatch dead on both the agent and the generic path is a dead dimension, not a fallback', async () => {
  // Nothing entered the audit without the rubric, so there is nothing to say about the rubric; the
  // dimension is NOT RUN — the same outcome as a dispatch that threw (engine-harness.test.mjs).
  const run = await runEngine('rust-audit', { args: {}, script: { ...base, architecture: { findings: [] } } })
  assert.ok(!/craft:rust-security-scanner/.test(run.report), 'a dead dimension is not reported as a generic fallback')
  assert.deepEqual((filedRecord(run) || {}).agentFallbacks, {})
})

test('rust-audit: with the synthesis dead, the INCOMPLETE return still names the unregistered agent', async () => {
  const architecture = ({ opts }) => {
    if (opts?.agentType) throw new Error(`agent type '${opts.agentType}' not found`)
    return { findings: [] }
  }
  const run = await runEngine('rust-audit', { args: {}, script: { ...base, synthesis: null, architecture } })
  assert.match(run.report, /INCOMPLETE — the Synthesize agent returned no result/, 'premise: the dead-synthesis return')
  assert.match(run.report, /`craft:rust-architecture-reviewer` is not registered/)
})
