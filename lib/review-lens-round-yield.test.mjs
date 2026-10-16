// Each lens round's confirmed yield on the filed record (realm @nick/craft, node #248): a finding
// remembers the round that first found it, through dedup and verification, so the record can say
// what round 2 bought — not only how many candidates it added.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'

const UPHELD = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'ok' }
const REFUTED = { refuted: true, citedLineMatches: false, reachable: false, premiseSupported: false, reason: 'no' }
/** @param {string} title @param {string} severity @param {number} line */
const finding = (title, severity, line) => ({
  severity, title, file: 'src/lib.rs', line, why: 'w', fix: 'f', blastRadius: '', source: 'safety', ruleId: '', symbol: 's', whereChecked: '',
})
// Titles carry the verdict the fake verifier gives them; round 2's dedup merge spans both rounds.
const BY_ROUND = /** @type {Record<string, object[]>} */ ({
  r1: [finding('KEEP one high', 'High', 10), finding('DROP one high', 'High', 20), finding('KEEP early twin', 'Medium', 30)],
  r2: [finding('KEEP two medium', 'Medium', 40), finding('DROP two high', 'High', 50), finding('KEEP late twin', 'Medium', 31)],
})
/** @param {string} text */
const verdictFor = text => (/DROP/.test(text) ? REFUTED : UPHELD)

function script() {
  return {
    detect: { baseRef: 'main', files: ['src/lib.rs'], spec: '', branch: 'feat/x', head: 'abc1234' },
    'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
    checkpoint: { runDir: '/store/.partial/run-A', error: '' },
    'log-run': { ok: true, error: '' },
    scout: { sizeBucket: 'medium', lenses: ['safety'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
    gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], notes: '', seedFindings: [{ ...finding('KEEP seed', 'High', 60), source: 'clippy' }] },
    /** @param {{ opts: { label?: string } }} arg */
    lens: ({ opts }) => ({ lens: 'safety', findings: BY_ROUND[String(opts.label).match(/ (r\d)\b/)?.[1] ?? ''] ?? [] }),
    // The two twins are one defect: merged, it was first found in round 1.
    /** @param {{ prompt: string }} arg */
    dedup: ({ prompt }) => {
      const at = (/** @type {string} */ t) => Number(prompt.match(new RegExp(`(\\d+)\\. [^\\n]*${t}`))?.[1])
      return { groups: [[at('KEEP early twin'), at('KEEP late twin')]] }
    },
    /** @param {{ prompt: string }} arg */
    verify: ({ prompt }) => verdictFor(prompt),
    /** @param {{ prompt: string }} arg */
    'verify-batch': ({ prompt }) => ({
      verdicts: prompt.split(/--- FINDING (\d+) ---/).flatMap((part, i, all) => (i % 2 ? [{ index: Number(part), ...verdictFor(all[i + 1] ?? '') }] : [])),
    }),
    synthesis: null,
    '*': null,
  }
}

const NONE = { Critical: 0, Medium: 0, Low: 0, Info: 0 }

test('the record says, per lens round, how many of the findings it first found were confirmed and at what severity', async () => {
  const run = await runEngine('review', { args: {}, script: script() })
  const rec = filedRecord(run)
  // The yield beside the fields older readers use, which keep their names.
  const rounds = (rec.lensRounds || []).map((/** @type {any} */ x) => ({
    language: x.language, round: x.round, newFindings: x.newFindings, costed: x.agents > 0 && x.returned > 0,
    confirmedCount: x.confirmedCount, confirmedBySeverity: x.confirmedBySeverity, suspectedCount: x.suspectedCount,
  }))
  assert.deepEqual(rounds.map((/** @type {any} */ x) => x.round), [1, 2], 'premise: a medium plan ran two rounds')
  assert.deepEqual(rounds[0], {
    language: 'rust', round: 1, newFindings: 3, costed: true,
    confirmedCount: 2, confirmedBySeverity: { ...NONE, High: 1, Medium: 1 }, suspectedCount: 0,
  }, 'round 1: its high and the merged twin confirmed, its refuted high not counted')
  assert.deepEqual(rounds[1], {
    language: 'rust', round: 2, newFindings: 3, costed: true,
    confirmedCount: 1, confirmedBySeverity: { ...NONE, High: 0, Medium: 1 }, suspectedCount: 0,
  }, 'round 2: only its medium — the late twin belongs to round 1, its high was refuted')
  assert.deepEqual(rec.seedYield, [{ language: 'rust', confirmedCount: 1, confirmedBySeverity: { ...NONE, High: 1, Medium: 0 }, suspectedCount: 0 }],
    'the gate seed is round 0, on its own field')
  const synth = run.calls.find(c => c.label === 'synthesis')
  assert.ok(synth && !synth.prompt.includes('foundInRound'), 'the synthesis prompt does not carry the record-only field')
})
