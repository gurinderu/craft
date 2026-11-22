// rust-audit reads the records past the cap by the diff's paths the scout names (changedFiles), so the
// cap keeps those closest to them, as its refusal says (keptRecords; realm @nick/craft, node #218).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'
import { PRIOR_DECISIONS_MAX } from './prior-decisions.mjs'

const green = { verdict: 'Approve', summary: 'ok', findings: [], evidence: 'Evidence: ran it' }
/** @param {string} title @param {string} scope @param {string} [id] */
const record = (title, scope, id) => ({
  ...(id ? { id } : {}),
  kind: 'decision',
  title,
  body: 'b',
  scope,
  status: 'active',
  date: '2026-09-30',
  author: 'bob',
  commit: 'def5678',
  links: [],
})
// PRIOR_DECISIONS_MAX records off the diff, then one without an id on the changed file: only the paths
// keep it under the cap, and then the memory line names its derived id.
const list = [
  ...Array.from({ length: PRIOR_DECISIONS_MAX }, (_, i) => record(`elsewhere ${i}`, `other/f${i}.rs`, `decision-o${i}`)),
  record('on the diff', 'src/a.rs'),
]

/** @param {Record<string, unknown>} args @param {string[] | undefined} changedFiles */
const audit = (args, changedFiles) =>
  runEngine('rust-audit', {
    args,
    script: {
      scout: {
        baseRef: 'main',
        hasUnsafe: false,
        crates: [],
        changedCrates: [],
        ...(changedFiles ? { changedFiles } : {}),
        edges: [],
        repoRoot: '/r',
        notes: 'n',
      },
      workflow: () => '## Verdict\n✅ Approve',
      synthesis: 'the audit body',
      'memory-recall': { backend: 'repo', why: 'w', decisions: [] },
      '*': green,
    },
  })

test('rust-audit: past the cap the record on a changed file is kept, recalled here or by the launcher', async () => {
  for (const args of [{ priorDecisions: list }, { priorDecisions: list, _recalled: true }]) {
    assert.match((await audit(args, ['src/a.rs'])).report, /id derived for 1 record\(s\): decision-\w+ \(on the diff\)/)
    assert.doesNotMatch((await audit(args, undefined)).report, /id derived for/, 'no paths: the order given decides')
  }
})
