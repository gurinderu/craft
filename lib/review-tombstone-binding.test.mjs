// The recidivism check per BINDING, through the real review engine (realm @nick/craft, vimarsha #242 on
// #89; rule #238): deadnix prints no rule and its seeds no symbol, so every deadnix finding in one file
// shares one fingerprint (file + symbol + ruleId). The ledger keeps, and the check reads, one tombstone
// per fingerprint AND normalized title for such a finding — the binding deadnix names — so the return of
// one binding is flagged and another binding of the same file is not.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'
import { fingerprint } from './run-record.mjs'

/** @param {string} title @param {string} why */
const tomb = (title, why) => {
  const base = { file: 'flake.nix', line: 3, symbol: '', severity: 'Medium', tier: 'confirmed', disposition: 'closed', source: 'deadnix', ruleId: 'MNT-001', title, why }
  return { fp: fingerprint(base), ...base }
}
/** @param {string} title */
const seed = title => ({ severity: 'Medium', title, file: 'flake.nix', line: 3, why: 'deadnix reported it', fix: 'drop it', blastRadius: '', source: 'deadnix', ruleId: 'MNT-001', symbol: '', whereChecked: '' })
const UPHELD = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'ok' }

/** @param {any[]} ledger @param {any[]} seeds */
const rereview = (ledger, seeds) => runEngine('review', {
  args: { languages: ['nix'] },
  script: {
    detect: { baseRef: 'main', files: ['flake.nix'], spec: '', branch: 'feat/x', head: 'abc9999' },
    'prior-round': { found: true, round: 2, head: 'abc0000', ledgerCount: ledger.length, priorFindings: ledger.length, reason: '', ledger, sameFpBasis: true },
    checkpoint: { runDir: '/store/.partial/run-B', error: '' },
    'log-run': { ok: true, error: '' },
    scout: { sizeBucket: 'small', lenses: ['maintainability'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
    gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: seeds, notes: '' },
    lens: { lens: 'maintainability', findings: [] },
    dedup: { groups: [] },
    verify: () => UPHELD,
    'verify-batch': (/** @type {{ prompt: string }} */ { prompt }) => ({ verdicts: [...prompt.matchAll(/--- FINDING (\d+) ---/g)].map(m => ({ index: Number(m[1]), ...UPHELD })) }),
    redteam: { defeated: false, attack: '' },
    carry: { changed: false, reason: 'unchanged' },
    synthesis: null,
    '*': null,
  },
})

/** The `why` handed to synthesis for the finding titled `title`. @param {any} run @param {string} title */
const whyOf = (run, title) => {
  const prompt = String(run.calls.find((/** @type {{ label: unknown }} */ c) => c.label === 'synthesis')?.prompt)
  const at = prompt.indexOf(`"title": "${title}"`) >= 0 ? prompt.indexOf(`"title": "${title}"`) : prompt.indexOf(`"title":"${title}"`)
  assert.ok(at >= 0, `the finding "${title}" reaches synthesis`)
  return prompt.slice(at, prompt.indexOf('}', at))
}

test('tombstone per binding: a fresh deadnix binding is not flagged by a resolved tombstone of another binding in the file', async () => {
  const run = await rereview([tomb('Unused lambda pattern: self', 'resolved in round 1')], [seed('Unused lambda pattern: pkgs')])
  assert.doesNotMatch(whyOf(run, 'Unused lambda pattern: pkgs'), /REGRESSION|re-raised/, 'pkgs never was resolved — self was')
})

test('tombstone per binding: with two closed bindings in one file, the return of one is flagged and another binding is not', async () => {
  // pkgs is the NEWER tombstone: with one slot per fingerprint it is the one remembered, and self's return
  // would be read against it.
  const ledger = [tomb('Unused lambda pattern: self', 'resolved in round 1'), tomb('Unused lambda pattern: pkgs', 'dismissed in round 2')]
  const run = await rereview(ledger, [seed('Unused lambda pattern: self'), seed('Unused lambda pattern: lib')])
  assert.match(whyOf(run, 'Unused lambda pattern: self'), /REGRESSION: this exact defect was resolved in round 1/, 'self came back — its own tombstone says resolved')
  assert.doesNotMatch(whyOf(run, 'Unused lambda pattern: lib'), /REGRESSION|re-raised/, 'lib was never closed')
  const kept = /** @type {any[]} */ ((filedRecord(run) || {}).ledger || []).filter(e => e.disposition === 'closed').map(e => e.title).sort()
  assert.deepEqual(kept, ['Unused lambda pattern: pkgs', 'Unused lambda pattern: self'], 'both bindings stay remembered on carry-forward')
})
