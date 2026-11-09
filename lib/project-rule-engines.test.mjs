// Project rules through the real engines (realm @nick/craft, node #273; lib/engine-harness.mjs): review and
// adversarial-review ask ONE rule judge after the decisions; a covered finding leaves the verdict and the
// PR comments for its own section; a Critical one is raised; a dead judge covers nothing and says so; the
// run record counts what was covered; rust-audit forwards recalled rules to its nested reviews.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'
const RULE = { kind: 'rule', title: 'we do not support rollback', scope: 'crates/node', body: 'deploys only go forward', status: 'active', date: '2026-10-20', author: 'nick', links: [] }
/** @param {any} run @param {string} label */
const calls = (run, label) => run.calls.filter((/** @type {{ label: unknown }} */ c) => c.label === label)

test('rust-audit: rules its recall returns are forwarded to every nested review, counted on its memory line', async () => {
  const green = { verdict: 'Approve', summary: 'ok', findings: [], evidence: 'Evidence: ran it' }
  const run = await runEngine('rust-audit', { args: {}, script: {
    scout: { baseRef: 'main', hasUnsafe: false, crates: [{ name: 'a', path: 'a' }], changedCrates: [{ name: 'a', path: 'a' }], edges: [], repoRoot: '/r', notes: 'n' },
    workflow: () => '## Verdict\n✅ Approve', synthesis: 'the audit body', 'memory-recall': { backend: 'repo', why: 'w', decisions: [], rules: [RULE] }, '*': green,
  } })
  const nested = calls(run, 'workflow').filter((/** @type {any} */ c) => !c.argv?.[1]?.gateOnly)
  assert.ok(nested.length >= 1)
  for (const c of nested) assert.equal(/** @type {any[]} */ (c.argv)[1].priorDecisions[0].kind, 'rule')
  assert.match(run.report, /memory: returned 0 decision\(s\) and 1 project rule\(s\) from repo/)
})
