// When the profile's dedicated reviewer agent is not available in the session (the craft plugin not
// enabled in that project), the engine runs every lens on the generic subagent — by design, so the
// review still happens. What it must not do is leave that to a log line and a red `failed` on the
// probe: the report says the agent was unavailable, what it cost, and how to enable it, and the run
// record names the profiles it happened to (realm @nick/craft #113). Driven through the whole engine.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'

const NOT_FOUND = ({ opts } = {}) => { throw new Error(`agent type '${opts?.agentType || 'craft:rust-reviewer'}' not found`) }

function script(over = {}) {
  return {
    detect: { baseRef: 'main', files: ['src/lib.rs'], spec: '', branch: 'feat/x', head: 'abc1234' },
    'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
    checkpoint: { runDir: '/store/.partial/run-A', error: '' },
    'log-run': { ok: true, error: '' },
    scout: { sizeBucket: 'small', lenses: ['safety'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
    gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
    'probe:rust': 'OK',
    lens: { lens: 'safety', findings: [] },
    dedup: { groups: [] },
    synthesis: null,
    '*': null,
    ...over,
  }
}
const lensCalls = calls => calls.filter(c => /^lens:/.test(String(c.opts?.label || '')))

test('a probe that finds no reviewer agent puts the cost and the fix in the report and on the record', async () => {
  const run = await runEngine('review', { args: {}, script: script({ 'probe:rust': NOT_FOUND }) })
  assert.ok(lensCalls(run.calls).length, 'premise: the lenses still ran')
  assert.ok(lensCalls(run.calls).every(c => !c.opts?.agentType), 'premise: on the generic subagent')
  const section = run.report.match(/## ⚠️ Reviewer agent unavailable[\s\S]*?(\n## |$)/)?.[0] || ''
  assert.match(section, /craft:rust-reviewer/, 'names the agent')
  assert.match(section, /generic subagent[^\n]*rubric/, 'names what it cost')
  assert.match(section, /\/plugin install craft@craft/, 'and how to enable it')
  assert.deepEqual(filedRecord(run)?.reviewerAgentUnavailable, ['rust'])
})

test('a lens that learns the agent is missing (probe answered) reports it the same way', async () => {
  const lens = ({ opts }) => {
    if (opts?.agentType) NOT_FOUND()
    return { lens: 'safety', findings: [] }
  }
  const run = await runEngine('review', { args: {}, script: script({ lens }) })
  assert.match(run.report, /## ⚠️ Reviewer agent unavailable/)
  assert.deepEqual(filedRecord(run)?.reviewerAgentUnavailable, ['rust'])
})

test('with the reviewer agent available there is no such section and the record lists none', async () => {
  const run = await runEngine('review', { args: {}, script: script() })
  assert.ok(lensCalls(run.calls).some(c => c.opts?.agentType === 'craft:rust-reviewer'), 'premise: lenses used the reviewer agent')
  assert.ok(!/Reviewer agent unavailable/.test(run.report))
  assert.deepEqual(filedRecord(run)?.reviewerAgentUnavailable, [])
})

test('a "not found" that is not about the agent type does not tell the operator to install the plugin', async () => {
  const run = await runEngine('review', { args: {}, script: script({ 'probe:rust': () => { throw new Error('model claude-x not found') } }) })
  assert.ok(!/plugin install/.test(run.report), 'a missing model is not a missing plugin')
  assert.deepEqual(filedRecord(run)?.reviewerAgentUnavailable, [])
})

test('the section carries the error the engine saw, so a misreading can be seen', async () => {
  const run = await runEngine('review', { args: {}, script: script({ 'probe:rust': NOT_FOUND }) })
  assert.match(run.report, /agent type 'craft:rust-reviewer' not found/)
})

test('an agent that answers with nothing is reported softly, without the install line', async () => {
  const lens = ({ opts }) => (opts?.agentType ? null : { lens: 'safety', findings: [] })
  const run = await runEngine('review', { args: {}, script: script({ lens }) })
  const section = run.report.match(/## ⚠️ Reviewer agent unavailable[\s\S]*?(\n## |$)/)?.[0] || ''
  assert.match(section, /returned nothing for \d+ lens dispatch/, 'the silent fallback is said')
  assert.match(section, /`craft:rust-reviewer` returned nothing/, 'naming the agent type that came back empty')
  assert.ok(!/plugin install/.test(section), 'but not as a missing plugin')
  const rec = filedRecord(run) || {}
  assert.deepEqual(rec.reviewerAgentUnavailable, [])
  assert.ok(rec.reviewerAgentFallbacks?.rust >= 1)
})

test('mixed run: only the language whose agent is missing is named, once', async () => {
  const s = script({ 'probe:nix': NOT_FOUND, 'probe:rust': 'OK' })
  s.detect = { ...s.detect, files: ['src/lib.rs', 'flake.nix'] }
  const run = await runEngine('review', { args: {}, script: s })
  const section = run.report.match(/## ⚠️ Reviewer agent unavailable[\s\S]*?(\n## |$)/)?.[0] || ''
  assert.equal((section.match(/^- /gm) || []).length, 1, 'one bullet')
  assert.match(section, /`craft:nix-reviewer`[^\n]*every nix lens/)
  assert.ok(!/rust/.test(section), 'rust is not named')
  assert.deepEqual(filedRecord(run)?.reviewerAgentUnavailable, ['nix'])
})
