// A record without an id through adversarial-review and rust-audit (realm @nick/craft, node #222):
// applied under the id derived from its kind, title and scope; rust-audit derives it before it forwards
// the list, so every nested review receives records that carry their id.
import crypto from 'node:crypto'
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'

/** @param {string} kind @param {string} title @param {string} scope */
const skillId = (kind, title, scope) => `${kind}-${crypto.createHash('sha256').update(`${kind}\n${title}\n${scope}`).digest('hex').slice(0, 10)}`

const TITLE = 'float arithmetic on amounts'
const NO_ID = { kind: 'decision', title: TITLE, body: 'amounts are display-only here', scope: 'src', status: 'active', date: '2026-09-30', author: 'bob', commit: 'def5678', links: ['https://x/pr/7#c1'] }
const ID = skillId('decision', TITLE, 'src')

const green = { verdict: 'Approve', summary: 'ok', findings: [], evidence: 'Evidence: ran it' }
/** @param {Record<string, unknown>} args @param {unknown} recall */
const audit = (args, recall) => runEngine('rust-audit', { args, script: {
  scout: { baseRef: 'main', hasUnsafe: false, crates: [{ name: 'a', path: 'a' }, { name: 'b', path: 'b' }], changedCrates: [{ name: 'a', path: 'a' }, { name: 'b', path: 'b' }], edges: [], repoRoot: '/r', notes: 'n' },
  workflow: () => '## Verdict\n✅ Approve', synthesis: 'the audit body', 'memory-recall': recall, '*': green,
} })

test('rust-audit: a passed record without an id is forwarded with the derived id, and the audit names the derivation', async () => {
  const run = await audit({ priorDecisions: [NO_ID] }, { backend: 'repo', why: 'w', decisions: [] })
  const nested = run.calls.filter(c => c.label === 'workflow' && !(/** @type {any} */ (c.argv)?.[1]?.gateOnly))
  assert.ok(nested.length >= 2)
  for (const c of nested) assert.deepEqual(/** @type {any[]} */ (c.argv)[1].priorDecisions, [{ ...NO_ID, id: ID }])
  assert.match(run.report, new RegExp(`id derived for 1 record\\(s\\): ${ID} \\(${TITLE}\\)`))
})

test('rust-audit: a launcher that already recalled — its records without an id are forwarded with the derived id too', async () => {
  const run = await audit({ priorDecisions: [NO_ID], _recalled: true }, null)
  assert.ok(!run.calls.some(c => c.label === 'memory-recall'))
  for (const c of run.calls.filter(x => x.label === 'workflow' && !(/** @type {any} */ (x.argv)?.[1]?.gateOnly))) assert.deepEqual(/** @type {any[]} */ (c.argv)[1].priorDecisions, [{ ...NO_ID, id: ID }])
})

test('rust-audit: a recalled record with a foreign id and a passed copy without one are forwarded as one record, the recalled under the skill id', async () => {
  const stored = { ...NO_ID, id: 'node-7', body: 'the store says so' }
  const run = await audit({ priorDecisions: [NO_ID] }, { backend: 'mcp', why: 'w', decisions: [stored] })
  for (const c of run.calls.filter(x => x.label === 'workflow' && !(/** @type {any} */ (x.argv)?.[1]?.gateOnly))) assert.deepEqual(/** @type {any[]} */ (c.argv)[1].priorDecisions, [{ ...stored, id: ID, links: [...stored.links, 'store: node-7'] }])
})

test('rust-audit: a passed copy of a record the store withdrew is not forwarded, and the audit names it once', async () => {
  const inactive = [{ id: 'node-7', kind: 'decision', title: TITLE, scope: 'src', status: 'withdrawn' }]
  const run = await audit({ priorDecisions: [NO_ID] }, { backend: 'mcp', why: 'w', decisions: [], inactive })
  const nested = run.calls.filter(c => c.label === 'workflow' && !(/** @type {any} */ (c.argv)?.[1]?.gateOnly))
  assert.ok(nested.length >= 2)
  for (const c of nested) assert.deepEqual(/** @type {any[]} */ (c.argv)[1].priorDecisions, [])
  assert.equal(run.report.match(new RegExp(`passed decision #0 \\(${ID}\\) not applied: withdrawn in memory`, 'g'))?.length, 1)
})
