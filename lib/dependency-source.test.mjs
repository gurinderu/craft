// The one instruction for finding a pinned dependency's source (lib/dependency-source.mjs) reaches
// the agents that must open that code to settle a premise: the triage validator and every
// adversarial-review lens.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'
import { DEPENDENCY_SOURCE_HOW } from './dependency-source.mjs'

test('the instruction names the pinned version, cargo metadata, cargo fetch, vendoring and other ecosystems', () => {
  assert.match(DEPENDENCY_SOURCE_HOW, /version the project pins/)
  assert.match(DEPENDENCY_SOURCE_HOW, /`manifest_path` from `cargo metadata --format-version 1`/)
  assert.match(DEPENDENCY_SOURCE_HOW, /Cargo\.lock/)
  assert.match(DEPENDENCY_SOURCE_HOW, /`cargo fetch`/)
  assert.match(DEPENDENCY_SOURCE_HOW, /vendor/)
  assert.match(DEPENDENCY_SOURCE_HOW, /lockfile/)
  assert.doesNotMatch(DEPENDENCY_SOURCE_HOW, /[\r\n]/)
})

test('triage-findings: the validator prompt carries the instruction beside its premise discipline', async () => {
  const r = await runEngine('triage-findings', {
    args: { report: '/r.md' },
    script: {
      'log-run': { ok: true },
      'gather:report': { source: 'rust-audit', findings: [{ severity: 'High', title: 'leak', location: 'src/a.rs:10', detail: 'd', proposed_fix: '', thread_id: '' }] },
      validate: { stable_id: 'rust-audit::src/a.rs:10::leak', verdict: 'accept', reason: 'real', fix_pointer: 'rust-errors: x', premise_checked: '' },
      plan: { plan_markdown: 'BODY', summary: 'S', ledger: [] },
    },
  })
  const prompt = r.calls.find(c => c.label.startsWith('validate:'))?.prompt ?? ''
  assert.ok(prompt.includes(DEPENDENCY_SOURCE_HOW), 'validator prompt carries the instruction')
  assert.ok(prompt.indexOf('PREMISE DISCIPLINE') < prompt.indexOf(DEPENDENCY_SOURCE_HOW), 'after the premise discipline')
})

test('adversarial-review: a lens prompt carries the instruction beside WHERE-CHECKED', async () => {
  const r = await runEngine('adversarial-review', {
    script: {
      scout: { baseRef: 'main', sizeBucket: 'small', lenses: ['correctness'], changedFiles: ['src/a.rs'], notes: 'n' },
      'index-warmup': { indexed: false, notes: 'x' },
      'coverage-critic': { findings: [] },
      'log-run': { ok: true },
      '*': () => ({ findings: [] }),
    },
  })
  const prompt = r.calls.find(c => c.label === 'review:correctness')?.prompt ?? ''
  assert.ok(prompt.includes(DEPENDENCY_SOURCE_HOW), 'lens prompt carries the instruction')
  assert.ok(prompt.indexOf('WHERE-CHECKED') < prompt.indexOf(DEPENDENCY_SOURCE_HOW), 'after WHERE-CHECKED')
})
