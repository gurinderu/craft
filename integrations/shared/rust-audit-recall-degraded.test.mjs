// rust-audit's one recall that may not have read the whole store — its backend query failed, its answer was truncated,
// its agent died or threw, or its launcher's recall was so: the audit names it degraded, and every nested CLI review is
// told why (`_recallDegraded`), so none reads its memory as clean.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'

const green = { verdict: 'Approve', summary: 'ok', findings: [], evidence: 'Evidence: ran it' }
const Q = 'iskron_search(q: "craft_kind") answered: nodes for query «craft_kind» not found'
const REC = {
  id: 'decision-0d2edebb6f',
  kind: 'decision',
  title: 't',
  body: 'b',
  scope: 'a',
  status: 'active',
  date: '2026-10-01',
  author: 'x',
  commit: 'abc1234',
  links: [],
}

/** @param {unknown} recall @param {Record<string, unknown>} [args] */
const audit = (recall, args = {}) =>
  runEngine('rust-audit', {
    args,
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

/** Every nested review is told why, beside `_recalled`. @param {{ calls: any[] }} r @param {RegExp} why */
function forwarded(r, why) {
  const nested = nestedArgs(r.calls)
  assert.ok(nested.length > 0)
  for (const a of nested) {
    assert.equal(a['_recalled'], true)
    assert.match(String(a['_recallDegraded']), why)
  }
}

test('rust-audit: a failed empty recall reaches every nested review as _recallDegraded and the audit reads it degraded', async () => {
  const r = await audit({ backend: 'mcp iskron', why: 'found by capability', decisions: [], queryError: Q })
  forwarded(r, /^not read — recall found nothing, backend query may have failed: iskron_search/)
  assert.match(r.report, /## Memory\n- memory: not read — found by capability; recall found nothing — backend query may have failed: /)
  assert.match(r.report, /\n- ⚠️ degraded: memory: not read — recall found nothing, backend query may have failed: /)
  assert.ok(
    r.logs.some(l => /⚠️ memory: not read — recall found nothing/.test(l)),
    'logged',
  )
})

test('rust-audit: a truncated recall and a partly failed one are forwarded with their records', async () => {
  const truncated = await audit({ backend: 'kg', why: 'w', decisions: [REC], truncated: '12 found, 10 shown' })
  forwarded(truncated, /^recall read only part of the backend's answer \(12 found, 10 shown\)/)
  for (const a of nestedArgs(truncated.calls)) assert.equal(/** @type {unknown[]} */ (a['priorDecisions']).length, 1)
  const partly = await audit({ backend: 'kg', why: 'w', decisions: [REC], queryError: 'kg_search(rule) refused' })
  forwarded(partly, /^recall partly failed — backend query may have failed: kg_search\(rule\) refused/)
})

test('rust-audit: a recall agent that died or threw is forwarded as failed, not clean', async () => {
  forwarded(await audit(null), /^not read — the recall agent died or returned no decision list/)
  const threw = await audit(() => {
    throw new Error('budget wall')
  })
  forwarded(threw, /^not read — the recall agent (did not run|died)/)
})

test("rust-audit: a launcher's degraded recall is kept, named and handed on", async () => {
  const r = await audit(null, { _recalled: true, priorDecisions: [REC], _recallDegraded: 'kg_search refused' })
  forwarded(r, /^the launcher's recall may not have read the whole store \(kg_search refused\)/)
  assert.match(r.report, /- ⚠️ degraded: memory: the launcher's recall may not have read the whole store \(kg_search refused\)/)
})

test('rust-audit: a clean empty recall forwards no _recallDegraded and reads as none', async () => {
  const r = await audit({ backend: 'mcp iskron', why: 'no craft record in the store', decisions: [] })
  for (const a of nestedArgs(r.calls)) assert.ok(!('_recallDegraded' in a))
  assert.match(r.report, /## Memory\n- memory: none — /)
  assert.doesNotMatch(r.report, /degraded: memory/)
})

test("rust-audit: a launcher's unreadable _recallDegraded is itself a degradation; a clean launcher recall forwards none", async () => {
  for (const bad of ['   ', 7, '\u001b']) {
    const r = await audit(null, { _recalled: true, priorDecisions: [REC], _recallDegraded: bad })
    forwarded(r, /^the launcher's recall may not have read the whole store \(the launcher passed an unreadable _recallDegraded/)
  }
  const clean = await audit(null, { _recalled: true, priorDecisions: [REC] })
  for (const a of nestedArgs(clean.calls)) assert.ok(!('_recallDegraded' in a))
})
