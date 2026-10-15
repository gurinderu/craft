// The report's verbatim tool titles on a RE-REVIEW, through the real review engine (realm @nick/craft,
// node #236): a deadnix prior still open or regressed is listed with its exact title — a regressed one
// beside a fresh Low seed's title at the same site, so the equal-title rule can pick; a fresh Medium
// seed naming another binding is not absorbed into the prior, standing or regressed (#238, #239); a
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

/** @param {string} report */
const titlesSection = report => {
  const at = report.indexOf(SECTION)
  assert.ok(at >= 0, report)
  const rest = report.slice(at + SECTION.length)
  const end = rest.search(/\n## /)
  return end < 0 ? rest : rest.slice(0, end)
}

test('re-review: a regressed deadnix prior is listed under the verbatim tool titles', async () => {
  assert.match(titlesSection((await rereview('regressed')).report), /\n- `flake\.nix:3` · Unused lambda pattern: self\n/)
})

test('re-review: a regressed prior and a fresh deadnix seed at the same site are both listed with their titles', async () => {
  const section = titlesSection((await rereview('regressed', [{ ...seed, severity: 'Low', file: 'flake.nix', line: 3 }])).report)
  assert.match(section, /\n- `flake\.nix:3` · Unused lambda pattern: self\n/)
  assert.match(section, /\n- `flake\.nix:3` · Unused lambda pattern: pkgs\n/)
})

test('re-review with synthesis down: a Suspected deadnix seed the fallback report prints is listed', async () => {
  const report = (await rereview('still-open', [seed])).report
  assert.match(report, /## Suspected/)
  assert.match(report, /## Tool finding titles \(verbatim\)\n(- .*\n)*- `lib\.nix:8` · Unused lambda pattern: pkgs/)
})

test('re-review: the synthesis prompt prints Suspected verbatim, so a listed Suspected seed has its report line', async () => {
  const run = await rereview('still-open', [seed])
  const prompt = String(run.calls.find((/** @type {{ label: unknown }} */ c) => c.label === 'synthesis')?.prompt)
  assert.match(prompt, /## Suspected \(needs confirmation\)` — the SUSPECTED JSON below/)
  assert.match(prompt, /In Still open, Regressed, New, Suspected and Unverified alike/)
  assert.match(prompt, /In Still open, Regressed, New, Suspected and Unverified alike: a finding with a non-empty `toolRule`[^\n]*labelled `tool:`[^\n]*`\[ruleId · tool: toolRule\]`/, 'the re-review rows carry the tool: label the bracket fallback reads')
  assert.match(prompt, /SUSPECTED JSON below[^\n]*never merge these into New or Still open/)
})

// A deadnix seed naming another binding is another finding: absorbing it into the prior at the same
// file+ruleId would drop it from the verbatim titles and the fix loop (realm @nick/craft, #238, #239).
for (const [status, line] of /** @type {const} */ ([['still-open', 8], ['regressed', 3]])) {
  test(`re-review: a fresh Medium deadnix seed for another binding is not absorbed into a ${status} prior`, async () => {
    const { report } = await rereview(status, [{ ...seed, file: 'flake.nix', line }])
    const section = titlesSection(report)
    assert.match(section, /\n- `flake\.nix:3` · Unused lambda pattern: self\n/)
    assert.match(section, new RegExp(`\\n- \`flake\\.nix:${line}\` · Unused lambda pattern: pkgs\\n`))
    assert.doesNotMatch(report, /also reported at/)
  })
}
