// The fresh-word override through the engines (realm @nick/craft, node #229): a passed copy newer than
// the store's inactive copy and than the active record superseding it is applied by adversarial-review
// and forwarded by rust-audit's own merge, the successor's link to it dropped; one not newer than the
// successor is held back, named by it. And a carried deferral is released through the review engine
// when a recalled record answers the question by the store's own id (realm @nick/craft, node #226).
import crypto from 'node:crypto'
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'

/** @param {string} kind @param {string} title @param {string} scope */
const skillId = (kind, title, scope) => `${kind}-${crypto.createHash('sha256').update(`${kind}\n${title}\n${scope}`).digest('hex').slice(0, 10)}`

const TITLE = 'float arithmetic on amounts'
const A = {
  kind: 'decision',
  title: TITLE,
  body: 'the fresh word',
  scope: 'src',
  date: '2026-10-05',
  author: 'bob',
  commit: 'def5678',
  links: ['https://x/pr/7#c1'],
}
const A_ID = skillId('decision', TITLE, 'src')
const B = {
  id: 'decision-bbbbbbbbbb',
  kind: 'decision',
  title: 'amounts use fixed point now',
  body: 'the successor',
  scope: 'src',
  status: 'active',
  author: 'alice',
  commit: 'def5678',
  links: [`supersedes: ${A_ID}`],
}
/** @param {string} bDate */
const recall = bDate => ({
  backend: 'mcp',
  why: 'w',
  decisions: [{ ...B, date: bDate }],
  inactive: [{ id: A_ID, kind: 'decision', title: TITLE, scope: 'src', status: 'superseded', date: '2026-10-01' }],
})

const green = { verdict: 'Approve', summary: 'ok', findings: [], evidence: 'Evidence: ran it' }
/** @param {unknown} memory */
const audit = memory =>
  runEngine('rust-audit', {
    args: { priorDecisions: [A] },
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
      'memory-recall': memory,
      '*': green,
    },
  })

test('rust-audit: a passed copy not newer than the successor is not forwarded, named by it once', async () => {
  const run = await audit(recall('2026-10-06'))
  for (const c of run.calls.filter(x => x.label === 'workflow' && !(/** @type {any} */ (x.argv)?.[1]?.gateOnly)))
    assert.deepEqual(
      /** @type {any[]} */ (/** @type {any[]} */ (c.argv)[1].priorDecisions).map(d => d.id),
      [B.id],
    )
  assert.equal(run.report.match(new RegExp(`passed decision #0 \\(${A_ID}\\) not applied: held by ${B.id} \\(active, 2026-10-06\\)`, 'g'))?.length, 1)
  assert.doesNotMatch(run.report, /applied over/)
})
