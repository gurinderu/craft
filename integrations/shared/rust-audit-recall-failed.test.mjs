// rust-audit's one recall that found nothing because its backend query may have failed: the audit names it degraded,
// and every nested CLI review is told the query (`_recallFailed`), so none reads its memory as clean.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'

const green = { verdict: 'Approve', summary: 'ok', findings: [], evidence: 'Evidence: ran it' }
const Q = 'iskron_search(q: "craft_kind") answered: nodes for query «craft_kind» not found'

/** @param {unknown} recall */
const audit = recall =>
  runEngine('rust-audit', {
    args: {},
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

/** The nested CLI reviews' arguments — every launch but the gate alone's. @param {{ label: string, argv?: any[] }[]} calls @returns {Record<string, unknown>[]} */
const nestedArgs = calls => calls.filter(c => c.label === 'workflow' && !c.argv?.[1]?.gateOnly).map(c => /** @type {any[]} */ (c.argv)[1])

test('rust-audit: a failed empty recall reaches every nested review as _recallFailed and the audit reads it degraded', async () => {
  const r = await audit({ backend: 'mcp iskron', why: 'found by capability', decisions: [], queryError: Q })
  const nested = nestedArgs(r.calls)
  assert.ok(nested.length > 0)
  for (const a of nested) assert.deepEqual([a['_recalled'], a['_recallFailed']], [true, Q])
  assert.match(r.report, /## Memory\n- memory: not read — found by capability; recall found nothing — backend query may have failed: /)
  assert.match(r.report, /\n- ⚠️ degraded: memory: not read — recall found nothing, backend query may have failed: /)
})

test('rust-audit: a clean empty recall forwards no _recallFailed and reads as none', async () => {
  const r = await audit({ backend: 'mcp iskron', why: 'no craft record in the store', decisions: [] })
  for (const a of nestedArgs(r.calls)) assert.ok(!('_recallFailed' in a))
  assert.match(r.report, /## Memory\n- memory: none — /)
  assert.doesNotMatch(r.report, /degraded: memory/)
})
