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
  const r = await runEngine('rust-audit', { args: {}, script: {
    scout: { baseRef: 'main', hasUnsafe: false, crates: [], changedCrates: [], edges: [], repoRoot: '/r', notes: 'n' },
    workflow: () => '## Verdict\n✅ Approve', synthesis: 'the audit body', '*': green,
  } })
  assert.doesNotMatch(r.report, /Prior decisions|Rejected before/)
})
