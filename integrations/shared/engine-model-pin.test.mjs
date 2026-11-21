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

const DECISION = {
  id: 'decision-bc2a4e82f6',
  kind: 'decision',
  title: 'float arithmetic on amounts',
  body: 'amounts are display-only here',
  scope: 'src',
  status: 'active',
  date: '2026-09-30',
  author: 'bob',
  commit: 'def5678',
  links: [],
}
const RULE = {
  kind: 'rule',
  title: 'no rollback',
  scope: 'src',
  body: 'deploys only go forward',
  status: 'active',
  date: '2026-10-20',
  author: 'nick',
  links: [],
}
/** @param {string} title @param {string} location */
const finding = (title, location) => ({ severity: 'Medium', title, location, detail: 'd', proposed_fix: '', thread_id: '' })

test('triage-findings: every agent it spawns, from gather to plan, names its model', async () => {
  const r = await runEngine('triage-findings', {
    args: { report: '/r.md', pr: '9', base: 'v1' },
    script: {
      'log-run': { ok: true },
      'gather:report': { source: 'review', findings: [finding('leak', 'src/a.rs:10')] },
      'gather:pr': { source: 'github-pr', findings: [finding('float arithmetic on amounts', 'src/pay.rs:4')] },
      'memory-recall': { backend: 'harness', why: 'the default', decisions: [DECISION], rules: [RULE] },
      'decision-scope': { unchanged: [DECISION.id], missing: [], reason: '' },
      validate: (/** @type {{ prompt: string }} */ { prompt }) => ({
        stable_id: /stable_id MUST be exactly: (.+)/.exec(prompt)?.[1] ?? '?',
        verdict: 'accept',
        reason: 'real',
        fix_pointer: 'rust-errors: x',
        premise_checked: '',
        noise_class: 0,
      }),
      plan: { plan_markdown: 'BODY', summary: 'S', ledger: [] },
    },
  })
  const labels = new Set(agentCalls(r).map(c => c.label.replace(/:.*$/, '')))
  for (const l of ['gather', 'memory-recall', 'decision-scope', 'decision-match', 'rule-match', 'validate', 'plan', 'log-run']) {
    assert.ok(labels.has(l), `the run reaches ${l}`)
  }
  assertPinned(r)
  // Extraction and lookup run on sonnet; the judgement against the code and the plan on opus.
  for (const l of ['gather:report', 'gather:pr', 'memory-recall', 'decision-scope']) assert.equal(modelOf(r, l), 'sonnet', l)
  for (const l of ['validate', 'plan']) assert.equal(modelOf(r, l), 'opus', l)
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
