// rust-audit keeps each nested review's report only up to a bound, and the prior-decision sections sit
// at its tail. They must reach the audit whole — lifted out before the bound, appended verbatim.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'

const green = { verdict: 'Approve', summary: 'ok', findings: [], evidence: 'Evidence: ran it' }
const REJECTED = '## Rejected before (set aside — not in the verdict)\n- Medium · `src/a.rs:3` · unwrap may panic · w · REJECTED BEFORE: validated upstream — alice'
const REFUSED = '## Prior decisions not applied\n- ⚠️ decision #1 (d2) lacks an id, a title or a reason'
const nested = `## Verdict\n✅ Approve\n\n${'filler line\n'.repeat(600)}\n\n${REFUSED}\n\n${REJECTED}\n\n## Scope\nwhole repo`

/** @param {unknown} synthesis */
const run = synthesis => runEngine('rust-audit', { args: {}, script: {
  scout: { baseRef: 'main', hasUnsafe: false, crates: [], changedCrates: [], edges: [], repoRoot: '/r', notes: 'n' },
  workflow: () => nested, synthesis, '*': green,
} })

test('rust-audit: the nested review\'s prior-decision sections survive the bound, verbatim, in the audit', async () => {
  for (const synthesis of ['the audit body', null]) {
    const r = await run(synthesis)
    assert.ok(r.report.includes(REJECTED), `Rejected before reaches the audit (synthesis ${synthesis === null ? 'dead' : 'alive'})`)
    assert.ok(r.report.includes(REFUSED), 'Prior decisions not applied reaches the audit')
    assert.match(r.report, /### review\n/, 'under the dimension it came from')
    assert.ok(!r.report.includes('## Scope\nwhole repo'), 'only those sections are lifted')
  }
})

test('rust-audit: a nested report without those sections adds nothing', async () => {
  const r = await runEngine('rust-audit', { args: { priorDecisions: [] }, script: {
    scout: { baseRef: 'main', hasUnsafe: false, crates: [], changedCrates: [], edges: [], repoRoot: '/r', notes: 'n' },
    workflow: () => '## Verdict\n✅ Approve', synthesis: 'the audit body', '*': green,
  } })
  assert.doesNotMatch(r.report, /Prior decisions|Rejected before/)
})

const RECORD = { id: 'decision-1', kind: 'decision', title: 'unwrap may panic', body: 'validated upstream', scope: 'src', status: 'active', date: '2026-10-01', author: 'alice', commit: 'abc1234', links: [] }

test('rust-audit (realm #203): absent priorDecisions → ONE recall at audit level, forwarded to every nested review, the source said once at the tail', async () => {
  /** @param {Record<string, unknown>} args @param {unknown} synthesis @param {unknown} recall */
  const audit = (args, synthesis, recall) => runEngine('rust-audit', { args, script: {
    scout: { baseRef: 'main', hasUnsafe: false, crates: [{ name: 'a', path: 'a' }, { name: 'b', path: 'b' }], changedCrates: [{ name: 'a', path: 'a' }, { name: 'b', path: 'b' }], edges: [], repoRoot: '/r', notes: 'n' },
    workflow: () => '## Verdict\n✅ Approve', synthesis, 'memory-recall': recall, '*': green,
  } })
  for (const synthesis of ['the audit body', null]) {
    const absent = await audit({}, synthesis, { backend: 'repo files', why: '.craft/memory exists', decisions: [RECORD] })
    assert.equal(absent.calls.filter(c => c.label === 'memory-recall').length, 1, 'one recall for the whole audit')
    const nested = absent.calls.filter(c => c.label === 'workflow')
    assert.ok(nested.length >= 2)
    for (const c of nested) assert.deepEqual(/** @type {any[]} */ (c.argv)[1].priorDecisions, [RECORD], 'each nested review gets the recalled list')
    assert.equal(absent.report.split('\n## Memory\n').length, 2, 'exactly once')
    // the audit does not parse the list: it counts what recall returned, never "recalled" (accepted)
    assert.match(absent.report, /## Memory\n- memory: returned 1 decision\(s\) from repo files \(\.craft\/memory exists\); each nested review reports how many it applied/)
    assert.doesNotMatch(absent.report, /memory: recalled/)
    const dead = await audit({}, synthesis, null)
    assert.match(dead.report, /## Memory\n- memory: none — the recall agent died/)
    for (const c of dead.calls.filter(x => x.label === 'workflow')) {
      assert.deepEqual(/** @type {any[]} */ (c.argv)[1].priorDecisions, [], 'a dead recall forwards an empty list, so no nested review recalls again')
      assert.match(/** @type {any[]} */ (c.argv)[1]._memory, /^the recall agent died/, 'with the outcome, so the nested report does not say "passed by the launcher (0)"')
    }
    for (const c of absent.calls.filter(x => x.label === 'workflow')) assert.ok(!('_memory' in /** @type {any[]} */ (c.argv)[1]), 'a recall that returned records forwards no outcome note')
    const given = await audit({ priorDecisions: [] }, synthesis, { backend: 'x', why: 'y', decisions: [RECORD] })
    assert.ok(!given.calls.some(c => c.label === 'memory-recall'), 'a passed list skips the recall')
    for (const c of given.calls.filter(x => x.label === 'workflow')) assert.ok(!('_memory' in /** @type {any[]} */ (c.argv)[1]), 'a passed list is forwarded as passed')
    assert.match(given.report, /## Memory\n- memory: passed by the launcher \(0\)/)
  }
})
