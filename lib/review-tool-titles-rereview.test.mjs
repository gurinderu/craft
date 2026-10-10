// The report's verbatim tool titles on a RE-REVIEW, through the real review engine: a deadnix prior
// adjudicated still-open or regressed is listed with its exact title, so a decision recorded on it in
// round 2 carries that title (realm @nick/craft, node #236).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'
import { fingerprint } from './run-record.mjs'

const TITLE = 'Unused lambda pattern: self'
const priorRow = () => {
  const base = { file: 'flake.nix', line: 3, symbol: '', severity: 'Medium', tier: 'confirmed', disposition: 'open', source: 'deadnix', ruleId: 'MNT-001', title: TITLE, why: 'deadnix reported it' }
  return { fp: fingerprint(base), ...base }
}

/** @param {string} status */
const scriptFor = status => ({
  detect: { baseRef: 'main', files: ['flake.nix'], spec: '', branch: 'feat/x', head: 'abc9999' },
  'prior-round': { found: true, round: 1, head: 'abc0000', ledgerCount: 1, priorFindings: 1, reason: '', ledger: [priorRow()], sameFpBasis: true },
  checkpoint: { runDir: '/store/.partial/run-B', error: '' },
  'log-run': { ok: true, error: '' },
  scout: { sizeBucket: 'small', lenses: ['maintainability'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
  gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
  lens: { lens: 'maintainability', findings: [] },
  dedup: { groups: [] },
  adjudicate: { status, note: status === 'regressed' ? 'another binding now' : '', attack: '', currentLine: 3 },
  redteam: { defeated: false, attack: '' },
  carry: { changed: false, reason: 'unchanged' },
  synthesis: null,
  '*': null,
})

for (const status of ['still-open', 'regressed']) {
  test(`re-review: a ${status} deadnix prior is listed under the verbatim tool titles`, async () => {
    const run = await runEngine('review', { args: { languages: ['nix'] }, script: scriptFor(status) })
    assert.match(run.report, /## Tool finding titles \(verbatim\)\n- `flake\.nix:3` · Unused lambda pattern: self/)
  })
}
