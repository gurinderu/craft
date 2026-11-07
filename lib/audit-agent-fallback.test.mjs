// rust-audit runs its contract/architecture/security/miri dimensions on dedicated craft agents. When one
// is not registered (the plugin not enabled in that project) the dimension runs on the generic subagent;
// the report and the record say so, with the same wording as review (realm @nick/craft #116).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'
import { aggregate } from './analyze-runs.mjs'
import { isAgentTypeMissing, agentUnavailableSection } from './agent-fallback.mjs'

/** @typedef {{ opts?: { agentType?: string } }} Dispatch */

const base = {
  scout: { hasDiff: false, hasUnsafe: false, baseRef: 'main', repoRoot: '/ws', notes: 'x', crates: [], changedCrates: [], edges: [] },
  synthesis: 'AUDIT-REPORT-BODY',
  'log-run': { ok: true },
  '*': null,
}

test('rust-audit: an unregistered architecture agent is named in the report and on the record', async () => {
  const architecture = (/** @type {Dispatch} */ { opts }) => {
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
  const architecture = (/** @type {Dispatch} */ { opts }) => {
    if (opts?.agentType) throw new Error('model opus-x not found')
    return { findings: [] }
  }
  const run = await runEngine('rust-audit', { args: {}, script: { ...base, architecture } })
  assert.match(run.report, /AUDIT-REPORT-BODY/, 'not a crashed audit')
  assert.ok(!/plugin install/.test(run.report), 'no install line for a missing model')
  assert.deepEqual(filedRecord(run)?.agentUnavailable, [])
  // The harness's live wording for an unregistered type is unobserved (#116): the dimension keeps its
  // coverage on the generic subagent, said softly, rather than dying on a guess about the text.
  assert.deepEqual(filedRecord(run)?.agentFallbacks, { 'craft:rust-architecture-reviewer': 1 })
  assert.match(run.report, /`craft:rust-architecture-reviewer` failed with "model opus-x not found" on 1 dimension dispatch/)
  assert.ok(!/returned nothing/.test(run.report), 'it threw: it did not return nothing')
})

test('rust-audit: dead on both paths after an unrecognised "not found", the dimension names the agent\'s error', async () => {
  const architecture = (/** @type {Dispatch} */ { opts }) => {
    if (opts?.agentType) throw new Error('model opus-x not found')
    return null
  }
  const run = await runEngine('rust-audit', { args: {}, script: { ...base, architecture } })
  assert.ok(run.logs.some(l => /model opus-x not found[^\n]*NOT RUN/.test(l)), 'the only error the engine saw is not lost')
  assert.deepEqual(filedRecord(run)?.agentFallbacks, {})
})

test('rust-audit: an empty-string generic answer is a dead dimension, not a counted fallback', async () => {
  const security = (/** @type {Dispatch} */ { opts }) => (opts?.agentType ? null : '')
  const run = await runEngine('rust-audit', { args: {}, script: { ...base, architecture: { findings: [] }, security } })
  assert.ok(!/craft:rust-security-scanner/.test(run.report), 'nothing entered the audit without the rubric')
  assert.deepEqual((filedRecord(run) || {}).agentFallbacks, {})
})

test('rust-audit: an unregistered agent whose generic re-run also dies is NOT RUN with the agent\'s error', async () => {
  const architecture = (/** @type {Dispatch} */ { opts }) => {
    if (opts?.agentType) throw new Error(`agent type '${opts.agentType}' not found`)
    return null
  }
  const run = await runEngine('rust-audit', { args: {}, script: { ...base, architecture } })
  assert.ok(run.logs.some(l => /agent type 'craft:rust-architecture-reviewer' not found[^\n]*NOT RUN/.test(l)), 'the dimension names the error')
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
  const security = (/** @type {Dispatch} */ { opts }) => (opts?.agentType ? null : { findings: [] })
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
  const architecture = (/** @type {Dispatch} */ { opts }) => {
    if (opts?.agentType) throw new Error(`agent type '${opts.agentType}' not found`)
    return { findings: [] }
  }
  const run = await runEngine('rust-audit', { args: {}, script: { ...base, synthesis: null, architecture } })
  assert.match(run.report, /INCOMPLETE — the Synthesize agent returned no result/, 'premise: the dead-synthesis return')
  assert.match(run.report, /`craft:rust-architecture-reviewer` is not registered/)
})

test('rust-audit: a whitespace-only synthesis is the INCOMPLETE return, not an empty report', async () => {
  const architecture = (/** @type {Dispatch} */ { opts }) => {
    if (opts?.agentType) throw new Error(`agent type '${opts.agentType}' not found`)
    return { findings: [] }
  }
  const script = { ...base, synthesis: '   \n ', 'log-run': null, architecture }
  const run = await runEngine('rust-audit', { args: {}, script })
  assert.match(run.report, /INCOMPLETE — the Synthesize agent returned no result/)
  assert.match(run.report, /## ⚠️ Telemetry lost/, 'the telemetry section still leads')
  assert.match(run.report, /`craft:rust-architecture-reviewer` is not registered/, 'the agent section is kept')
  assert.ok(!run.report.endsWith('   \n '), 'the blank answer is not passed off as the report body')
})

// realm @nick/craft #153: the nested per-crate review runs on craft:rust-reviewer; when that agent is not
// registered, only the nested report says so. The audit reads that section back into its own report and record.
/** @param {string} agent @returns {string} */
const nestedReport = agent => `## ⚠️ Reviewer agent unavailable\n- \`${agent}\` is not registered in this session, so every rust lens went to the generic subagent, without that agent's rubric — this run is weaker than a normal one, not broken. (Agent type '${agent}' not found. Available agents: claude, general-purpose)\nEnable the plugin in this project (\`/plugin install craft@craft\`, project or local scope) and re-run to use it.\n\n## Verdict\n✅ Approve`
const TWO_CRATES = {
  hasDiff: true, hasUnsafe: false, baseRef: 'main', repoRoot: '/ws', notes: 'x', edges: [],
  crates: [{ name: 'a', path: 'crates/a' }, { name: 'b', path: 'crates/b' }],
  changedCrates: [{ name: 'a', path: 'crates/a' }, { name: 'b', path: 'crates/b' }],
}

test('rust-audit (whole-workspace site): the nested review\'s unavailable agent reaches the audit report and record', async () => {
  const run = await runEngine('rust-audit', { args: {}, script: { ...base, architecture: { findings: [] }, security: { findings: [] }, workflow: nestedReport('craft:rust-reviewer') } })
  assert.match(run.report, /AUDIT-REPORT-BODY/, 'premise: the audit completed')
  const section = run.report.match(/## ⚠️ Reviewer agent unavailable[\s\S]*?(\n\n|$)/)?.[0] || ''
  assert.match(section, /`craft:rust-reviewer` is not registered[^\n]*nested review/)
  assert.match(run.report, /\/plugin install craft@craft/)
  // The nested review files its own record (`nested`, `via: 'rust-audit'`) carrying this fact; the audit's
  // record repeating it would count one unavailable agent twice in analyze-runs.
  assert.deepEqual(filedRecord(run)?.agentUnavailable, [])
})

test('rust-audit (per-crate fan-out site): each crate\'s nested review names its unavailable agent', async () => {
  const workflow = () => nestedReport('craft:rust-reviewer')
  const run = await runEngine('rust-audit', { args: {}, script: { ...base, scout: TWO_CRATES, architecture: { findings: [] }, security: { findings: [] }, workflow } })
  assert.match(run.report, /`craft:rust-reviewer` is not registered[^\n]*review:a/)
  assert.match(run.report, /`craft:rust-reviewer` is not registered[^\n]*review:b/)
  assert.deepEqual(filedRecord(run)?.agentUnavailable, [])
})

test('rust-audit: a nested review that fell back softly is said in the audit report, without the install line', async () => {
  const soft = '## ⚠️ Reviewer agent unavailable\n- `craft:rust-reviewer` returned nothing for 3 lens dispatch(es), which were re-run on the generic subagent, without its rubric (an unregistered agent on some runtimes, or a transient failure).\n\n## Verdict\n✅ Approve'
  const run = await runEngine('rust-audit', { args: {}, script: { ...base, architecture: { findings: [] }, security: { findings: [] }, workflow: soft } })
  assert.match(run.report, /`craft:rust-reviewer` returned nothing for 3 [^\n]*nested review/)
  assert.ok(!/plugin install/.test(run.report))
  assert.deepEqual(filedRecord(run)?.agentFallbacks, {})
})

test('rust-audit: a nested review with every agent present adds nothing', async () => {
  const run = await runEngine('rust-audit', { args: {}, script: { ...base, architecture: { findings: [] }, security: { findings: [] }, workflow: '## Verdict\n✅ Approve' } })
  assert.ok(!/Reviewer agent unavailable/.test(run.report))
  assert.deepEqual(filedRecord(run)?.agentUnavailable, [])
  assert.deepEqual(filedRecord(run)?.agentFallbacks, {})
})

// One audit session with one unavailable agent in its nested review: the nested review's record and the
// audit's record together count it once — one run, the nested review's dispatches — in analyze-runs.
test('rust-audit + its nested review: one unavailable agent is one run and N dispatches in the aggregate', async () => {
  const nested = { name: 'review', nested: true, via: 'rust-audit', agentUnavailable: ['craft:rust-reviewer'], agentFallbacks: {} }
  const softNested = { name: 'review', nested: true, via: 'rust-audit', agentUnavailable: [], agentFallbacks: { 'craft:rust-reviewer': 3 } }
  const soft = '## ⚠️ Reviewer agent unavailable\n- `craft:rust-reviewer` returned nothing for 3 lens dispatch(es), which were re-run on the generic subagent, without its rubric (an unregistered agent on some runtimes, or a transient failure).\n\n## Verdict\n✅ Approve'
  const hard = await runEngine('rust-audit', { args: {}, script: { ...base, architecture: { findings: [] }, security: { findings: [] }, workflow: nestedReport('craft:rust-reviewer') } })
  const a = aggregate([filedRecord(hard), nested])
  assert.deepEqual(a.agentUnavailable, [{ agent: 'craft:rust-reviewer', runs: 1 }])
  const softRun = await runEngine('rust-audit', { args: {}, script: { ...base, architecture: { findings: [] }, security: { findings: [] }, workflow: soft } })
  const b = aggregate([filedRecord(softRun), softNested])
  assert.deepEqual(b.agentFallbacks, [{ agent: 'craft:rust-reviewer', dispatches: 3, runs: 1 }])
})
