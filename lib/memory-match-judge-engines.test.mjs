// Matching a remembered record to a finding the model reworded (realm @nick/craft, node #230), through
// the real review and adversarial-review engines (lib/engine-harness.mjs): a record anchored by file,
// line (±3) and lens answers a finding without a judge; a disputed pair goes to ONE cheap judge whose
// verdict and one-line why decide, and whose death raises the finding, named once; a record without
// line and lens keeps the title-overlap rule. An overriding passed record is tried before its successor.
import crypto from 'node:crypto'
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'

/** @param {string} kind @param {string} title @param {string} scope */
const skillId = (kind, title, scope) => `${kind}-${crypto.createHash('sha256').update(`${kind}\n${title}\n${scope}`).digest('hex').slice(0, 10)}`
const O_TITLE = 'float arithmetic on amounts'
const O_ID = skillId('decision', O_TITLE, 'src/pay.rs')
const FRESH = {
  kind: 'decision',
  title: O_TITLE,
  body: 'the fresh word',
  scope: 'src/pay.rs',
  date: '2026-10-05',
  author: 'bob',
  commit: 'def5678',
  links: [],
  line: 4,
  lens: 'correctness',
}
const SUCCESSOR = {
  id: 'decision-bbbbbbbbbb',
  kind: 'decision',
  title: 'amounts use fixed point now',
  body: 'the successor',
  scope: 'src/pay.rs',
  status: 'active',
  date: '2026-10-03',
  author: 'alice',
  commit: 'def5678',
  links: [`supersedes: ${O_ID}`],
  line: 4,
  lens: 'correctness',
}

test('rust-audit: the forwarded overriding record names the successor it overrides, so a nested review tries it first', async () => {
  const recall = {
    backend: 'mcp',
    why: 'w',
    decisions: [SUCCESSOR],
    inactive: [{ id: O_ID, kind: 'decision', title: O_TITLE, scope: 'src/pay.rs', status: 'superseded', date: '2026-10-01' }],
  }
  const green = { verdict: 'Approve', summary: 'ok', findings: [], evidence: 'Evidence: ran it' }
  const run = await runEngine('rust-audit', {
    args: { priorDecisions: [FRESH] },
    script: {
      scout: {
        baseRef: 'main',
        hasUnsafe: false,
        crates: [{ name: 'a', path: 'a' }],
        changedCrates: [{ name: 'a', path: 'a' }],
        edges: [],
        repoRoot: '/r',
        notes: 'n',
      },
      workflow: () => '## Verdict\n✅ Approve',
      synthesis: 'the audit body',
      'memory-recall': recall,
      '*': green,
    },
  })
  const nested = run.calls.filter(c => c.label === 'workflow' && !(/** @type {any} */ (c.argv)?.[1]?.gateOnly))
  assert.ok(nested.length >= 1)
  for (const c of nested) {
    const list = /** @type {any[]} */ (/** @type {any[]} */ (c.argv)[1].priorDecisions)
    assert.deepEqual(list.find(d => d.id === O_ID)?.overrides, [SUCCESSOR.id])
  }
})
