// Every agent triage-findings and rust-audit spawn names its model (realm `@nick/craft`, node #553). An agent with
// no `model` runs on the launching session's model, so a triage started from a session on another model ran on that
// model throughout, its cost and judgement set by whoever launched it. These run both engines through the engine
// harness on paths that reach every dispatch they make and hold each dispatched agent — not a list of labels — to an
// explicit model, so a call added later without one fails here, then pin each step's own model. The review engine's
// pins (the model the binary names per task, the service steps' haiku) are covered by the `cli-review-*` tests.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'

/** @typedef {import('./engine-harness.mjs').Call} Call */

const MODELS = new Set(['opus', 'sonnet', 'haiku'])

/** The agent dispatches of a run: a nested `workflow()` is an engine, not an agent. @param {{ calls: Call[] }} r */
const agentCalls = r => r.calls.filter(c => c.label !== 'workflow')

/** @param {Call | undefined} c @returns {unknown} */
const modelIn = c => /** @type {{ model?: unknown }} */ (c?.opts ?? {}).model

/** @param {{ calls: Call[] }} r */
function assertPinned(r) {
  const unpinned = agentCalls(r)
    .filter(c => {
      const m = modelIn(c)
      return typeof m !== 'string' || !MODELS.has(m)
    })
    .map(c => c.label)
  assert.deepEqual(unpinned, [], 'every spawned agent names its model')
}

/** @param {{ calls: Call[] }} r @param {string} label @returns {unknown} */
const modelOf = (r, label) => modelIn(r.calls.find(c => c.label === label || c.label.startsWith(`${label}:`) || c.label.startsWith(`${label}#`)))

/** A service agent's answer carrying `value` as stdout. @param {unknown} value */
const ran = value => ({ exitCode: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' })
/** A task of the triage's binary, on the model it names. @param {string} id @param {string} model @param {string} kind */
const triageTask = (id, model, kind) => ({ id, label: id, model, kind, promptFile: `/r/${id}.md`, schemaFile: `/r/${id}.json`, answerFile: `/r/a/${id}.json` })

// The triage's agents are the binary's tasks, each on the model the binary names (craft-triage holds them to the engine's
// table: sonnet for extraction and lookup, opus for the judgement against the code and the plan), and the service
// steps that run the binary, on haiku; a run the binary never finished adds the logger, on haiku too.
test('triage-findings: every agent it spawns — service steps, the binary’s tasks, the logger — names its model', async () => {
  const tasks = [triageTask('gather-report', 'sonnet', 'gatherReport'), triageTask('recall', 'sonnet', 'recall'), triageTask('validate-0', 'opus', 'validate')]
  const r = await runEngine('triage-findings', {
    args: { report: '/r.md' },
    script: {
      'step:resolve': ran('root=/p\nbin=/b/craft\n'),
      'step:start': ran({ run: '/r', done: false, phase: 'gather', tasks }),
      'gather-report': 'done',
      recall: 'done',
      'validate-0': 'done',
      'step:submit:1': ran({ run: '/r', done: false, phase: 'plan', tasks: [triageTask('plan', 'opus', 'plan')] }),
      plan: 'done',
      'step:submit:2': null,
      'step:status': null,
      'log-run': { ok: true },
    },
  })
  for (const l of ['step:resolve', 'step:start', 'gather-report', 'recall', 'validate-0', 'plan', 'step:status', 'log-run'])
    assert.ok(
      r.calls.some(c => c.label === l || c.label.startsWith(`${l}:`) || c.label.startsWith(`${l}#`)),
      `the run reaches ${l}`,
    )
  assertPinned(r)
  for (const l of ['gather-report', 'recall']) assert.equal(modelOf(r, l), 'sonnet', l)
  for (const l of ['validate-0', 'plan']) assert.equal(modelOf(r, l), 'opus', l)
  for (const l of ['step:start', 'step:submit', 'step:status']) assert.equal(modelOf(r, l), 'haiku', l)
})

test('rust-audit: every agent it spawns, every dimension dispatched, names its model', async () => {
  const green = { verdict: 'Approve', summary: 'ok', findings: [], evidence: 'Evidence: ran it' }
  const crate = { name: 'a', path: 'crates/a' }
  const r = await runEngine('rust-audit', {
    args: {},
    script: {
      scout: {
        baseRef: '',
        hasUnsafe: true,
        crates: [crate, { name: 'b', path: 'crates/b' }],
        changedCrates: [],
        edges: [{ from: 'a', to: 'b' }],
        repoRoot: '/r',
        notes: 'n',
      },
      workflow: () => '## Verdict\n✅ Approve',
      'unused-crates:find': { ...green, findings: [{ severity: 'Low', title: 'unused-dep: x in a', location: 'crates/a/Cargo.toml:3', detail: 'd' }] },
      'unused-crates:verify': { confirmedUnused: true, evidence: 'grep found no use', removal: 'drop x' },
      synthesis: 'the audit body',
      'memory-recall': { backend: 'repo', why: 'w', decisions: [] },
      '*': green,
    },
  })
  const labels = new Set(agentCalls(r).map(c => c.label.replace(/[:#].*$/, '')))
  for (const l of [
    'scout',
    'memory-recall',
    'contract',
    'crate-decomposition',
    'architecture',
    'security',
    'miri',
    'semver',
    'build-matrix',
    'deps',
    'unused-crates',
    'tests-cov',
    'synthesis',
  ]) {
    assert.ok(labels.has(l), `the run reaches ${l}`)
  }
  assert.ok(
    agentCalls(r).some(c => c.label.startsWith('unused-crates:verify')),
    'the run reaches the unused-crates verifier',
  )
  assertPinned(r)
  // The scout is mechanics on haiku; the recall and the tool-running dimensions on sonnet; the judgement steps,
  // the verifier and the synthesis that writes the report the human reads on opus.
  assert.equal(modelOf(r, 'scout'), 'haiku', 'scout')
  for (const l of ['memory-recall', 'semver', 'build-matrix', 'deps', 'unused-crates:find', 'tests-cov']) assert.equal(modelOf(r, l), 'sonnet', l)
  for (const l of ['contract', 'architecture', 'security', 'miri', 'crate-decomposition', 'unused-crates:verify', 'synthesis']) {
    assert.equal(modelOf(r, l), 'opus', l)
  }
})
