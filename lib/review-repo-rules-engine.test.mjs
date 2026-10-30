// The reviewed repository's rule files reach every lens (realm @nick/craft, node #406), driven through the
// whole engine: the scout returns their paths, each lens prompt names them in one line, the run record keeps
// them; with none found the line is absent.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'

const RULES = ['AGENTS.md', '.github/copilot-instructions.md']
const LENSES = ['safety', 'errors', 'intent', 'invariants', 'negative-space']

/** @param {unknown} repoRules @returns {Record<string, any>} */
function script(repoRules) {
  return {
    detect: { baseRef: 'main', files: ['src/lib.rs'], spec: '', branch: 'feat/x', head: 'abc1234' },
    'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
    checkpoint: { runDir: '/store/.partial/run-A', error: '' },
    'log-run': { ok: true, error: '' },
    scout: { sizeBucket: 'large', lenses: LENSES, isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x', ...(repoRules === undefined ? {} : { repoRules }) },
    gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
    lens: { lens: 'x', findings: [] },
    dedup: { groups: [] },
    'extra-lens': (/** @type {{ opts: any }} */ { opts }) => ({ lens: opts.agentType, findings: [] }),
    synthesis: null,
    '*': null,
  }
}

/** @param {import('./engine-harness.mjs').Call[]} calls */
const lensCalls = calls => calls.filter(c => /^lens:/.test(c.label) || c.key === 'extra-lens')

test('the scout is asked for the rule files by path, not content', async () => {
  const { calls } = await runEngine('review', { args: {}, script: script([]) })
  const scout = calls.find(c => c.key === 'scout')
  assert.match(String(scout?.prompt), /repoRules: the repository's own rule files at HEAD .*do not read them/)
})

test('rule paths from the scout: every lens prompt, the extra lens included, carries the line', async () => {
  const run = await runEngine('review', { args: { extraLenses: ['reviewer'] }, script: script([...RULES, '../escape.md']) })
  const lenses = lensCalls(run.calls)
  assert.ok(lenses.some(c => /negative-space/.test(c.label)) && lenses.some(c => c.key === 'extra-lens'), 'negative-space and the extra lens must have run')
  for (const c of lenses) {
    assert.ok(c.prompt.includes('REPO RULES: `AGENTS.md`, `.github/copilot-instructions.md` — read them'), `${c.label} lacks the repo-rules line`)
    assert.ok(!c.prompt.includes('escape.md'), `${c.label} carries a path that steps outside the repository`)
  }
  assert.deepEqual(filedRecord(run).repoRules, RULES)
})

test('no rule files: no lens prompt carries the line, and the record says none', async () => {
  for (const answer of [[], undefined]) {
    const run = await runEngine('review', { args: { extraLenses: ['reviewer'] }, script: script(answer) })
    const lenses = lensCalls(run.calls)
    assert.ok(lenses.length >= LENSES.length, 'the lenses must have run')
    for (const c of lenses) assert.ok(!c.prompt.includes('REPO RULES:'), `${c.label} carries a repo-rules line with no rule file found`)
    assert.deepEqual(filedRecord(run).repoRules, [])
  }
})
