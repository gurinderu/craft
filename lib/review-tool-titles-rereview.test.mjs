// The report's verbatim tool titles on a RE-REVIEW, through the real review engine (realm @nick/craft,
// node #236): a deadnix prior still open is listed with its exact title; a regressed one is not — it
// keeps the prior round's title, and a deadnix regression at that site is usually another binding; a
// Suspected seed is listed, since the report prints Suspected on a re-review too.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'
import { fingerprint } from './run-record.mjs'

const TITLE = 'Unused lambda pattern: self'
const SECTION = '## Tool finding titles (verbatim)'
const priorRow = () => {
  const base = { file: 'flake.nix', line: 3, symbol: '', severity: 'Medium', tier: 'confirmed', disposition: 'open', source: 'deadnix', ruleId: 'MNT-001', title: TITLE, why: 'deadnix reported it' }
  return { fp: fingerprint(base), ...base }
}
const SUSPECT = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: false, reason: 'premise not pinned' }
const seed = { severity: 'Medium', title: 'Unused lambda pattern: pkgs', file: 'lib.nix', line: 8, why: 'deadnix reported it', fix: 'drop it', blastRadius: '', source: 'deadnix', ruleId: 'MNT-001', symbol: '', whereChecked: '' }

/** @param {string} status @param {any[]} [seeds] */
const scriptFor = (status, seeds = []) => ({
  detect: { baseRef: 'main', files: ['flake.nix', 'lib.nix'], spec: '', branch: 'feat/x', head: 'abc9999' },
  'prior-round': { found: true, round: 1, head: 'abc0000', ledgerCount: 1, priorFindings: 1, reason: '', ledger: [priorRow()], sameFpBasis: true },
  checkpoint: { runDir: '/store/.partial/run-B', error: '' },
  'log-run': { ok: true, error: '' },
  scout: { sizeBucket: 'small', lenses: ['maintainability'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
  gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: seeds, notes: '' },
  lens: { lens: 'maintainability', findings: [] },
  dedup: { groups: [] },
  verify: () => SUSPECT,
  'verify-batch': (/** @type {{ prompt: string }} */ { prompt }) => ({ verdicts: [...prompt.matchAll(/--- FINDING (\d+) ---/g)].map(m => ({ index: Number(m[1]), ...SUSPECT })) }),
  adjudicate: { status, note: status === 'regressed' ? 'another binding now' : '', attack: '', currentLine: 3 },
  redteam: { defeated: false, attack: '' },
  carry: { changed: false, reason: 'unchanged' },
  synthesis: null,
  '*': null,
})
/** @param {string} status @param {any[]} [seeds] */
const rereview = (status, seeds) => runEngine('review', { args: { languages: ['nix'] }, script: scriptFor(status, seeds) })

test('re-review: a still-open deadnix prior is listed under the verbatim tool titles', async () => {
  assert.match((await rereview('still-open')).report, /## Tool finding titles \(verbatim\)\n- `flake\.nix:3` · Unused lambda pattern: self/)
})

test('re-review: a regressed deadnix prior is not listed — its title is the prior round\'s', async () => {
  const report = (await rereview('regressed')).report
  assert.ok(!report.includes(`${SECTION}\n- \`flake.nix:3\` · ${TITLE}`), report.slice(report.indexOf(SECTION)))
})

test('re-review with synthesis down: a Suspected deadnix seed the fallback report prints is listed', async () => {
  const report = (await rereview('still-open', [seed])).report
  assert.match(report, /## Suspected/)
  assert.match(report, /## Tool finding titles \(verbatim\)\n(- .*\n)*- `lib\.nix:8` · Unused lambda pattern: pkgs/)
})
