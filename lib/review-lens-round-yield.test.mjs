// Each lens round's confirmed yield on the filed record (realm @nick/craft, node #248): a finding
// remembers the round that first found it, through dedup, roll-up and verification, so the record
// can say what round 2 bought — not only how many candidates it added.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'

const UPHELD = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'ok' }
const REFUTED = { refuted: true, citedLineMatches: false, reachable: false, premiseSupported: false, reason: 'no' }
/** @param {string} title @param {string} severity @param {number} line @param {string} [ruleId] */
const finding = (title, severity, line, ruleId = '') => ({
  severity, title, file: 'src/lib.rs', line, why: 'w', fix: 'f', blastRadius: '', source: 'safety', ruleId, symbol: 's', whereChecked: '',
})
/** @param {string} text */
const verdictFor = text => (/DROP/.test(text) ? REFUTED : UPHELD)
const NONE = { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 }

/** @param {Record<string, object[]>} byRound @param {string[][]} twins titles the dedup pass groups */
function script(byRound, twins = []) {
  return {
    detect: { baseRef: 'main', files: ['src/lib.rs'], spec: '', branch: 'feat/x', head: 'abc1234' },
    'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
    checkpoint: { runDir: '/store/.partial/run-A', error: '' },
    'log-run': { ok: true, output: ['wrote r.json'] },
    scout: { sizeBucket: 'medium', lenses: ['safety'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
    gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], notes: '', seedFindings: [{ ...finding('KEEP seed', 'High', 60), source: 'clippy' }] },
    /** @param {{ opts: { label?: string } }} arg */
    lens: ({ opts }) => ({ lens: 'safety', findings: byRound[String(opts.label).match(/ (r\d)\b/)?.[1] ?? ''] ?? [] }),
    /** @param {{ prompt: string }} arg */
    dedup: ({ prompt }) => ({ groups: twins.map(g => g.map(t => Number(prompt.split('\n').find(l => /^\s*\d+\. /.test(l) && l.includes(t))?.match(/(\d+)\. /)?.[1]))) }),
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

/** The yield beside the fields older readers use, which keep their names. @param {any} rec */
const roundsOf = rec => (rec.lensRounds || []).map((/** @type {any} */ x) => ({
  language: x.language, round: x.round, newFindings: x.newFindings, costed: x.agents > 0 && x.returned > 0,
  confirmedCount: x.confirmedCount, confirmedBySeverity: x.confirmedBySeverity, suspectedCount: x.suspectedCount,
}))

test('the record says, per lens round, how many of the findings it first found were confirmed and at what severity', async () => {
  // The late twin is the stricter one, so the dedup merge takes it as base — yet the defect was first found in round 1.
  const run = await runEngine('review', { args: {}, script: script({
    r1: [finding('KEEP one high', 'High', 10), finding('DROP one high', 'High', 20), finding('KEEP early twin', 'Medium', 30)],
    r2: [finding('KEEP two medium', 'Medium', 40), finding('DROP two high', 'High', 50), finding('KEEP late twin', 'High', 31)],
  }, [['KEEP early twin', 'KEEP late twin']]) })
  const rec = filedRecord(run)
  const rounds = roundsOf(rec)
  assert.deepEqual(rounds.map((/** @type {any} */ x) => x.round), [1, 2], 'premise: a medium plan ran two rounds')
  assert.deepEqual(rounds[0], {
    language: 'rust', round: 1, newFindings: 3, costed: true,
    confirmedCount: 2, confirmedBySeverity: { ...NONE, High: 2 }, suspectedCount: 0,
  }, 'round 1: its high and the merged twin (High, from its round-2 base) confirmed, its refuted high not counted')
  assert.deepEqual(rounds[1], {
    language: 'rust', round: 2, newFindings: 3, costed: true,
    confirmedCount: 1, confirmedBySeverity: { ...NONE, Medium: 1 }, suspectedCount: 0,
  }, 'round 2: only its medium — the late twin belongs to round 1, its high was refuted')
  assert.deepEqual(rec.seedYield, [{ language: 'rust', confirmedCount: 1, confirmedBySeverity: { ...NONE, High: 1 }, suspectedCount: 0, unattributedConfirmed: 0 }],
    'the gate seed is round 0, on its own field; every confirmed finding here came from a round')
  const synth = run.calls.find(c => c.label === 'synthesis')
  assert.ok(synth && !synth.prompt.includes('foundInRound'), 'the synthesis prompt does not carry the record-only field')
})

test('a rolled-up finding keeps the earliest round of what it folded, not its representative\'s', async () => {
  // API-003 is a rust roll-up rule: the three Highs stay, the round-2 Medium represents the folded
  // pair, and the folded Low was first found in round 1.
  const flood = (/** @type {string} */ t, /** @type {string} */ sev, /** @type {number} */ line) => finding(`KEEP flood ${t}`, sev, line, 'API-003')
  const rec = filedRecord(await runEngine('review', { args: {}, script: script({
    r1: [flood('a', 'High', 10), flood('b', 'High', 20), flood('c', 'High', 30), flood('low', 'Low', 40)],
    r2: [flood('mid', 'Medium', 50)],
  }) }))
  const rounds = roundsOf(rec)
  assert.deepEqual(rounds.map((/** @type {any} */ x) => x.confirmedBySeverity), [{ ...NONE, High: 3, Medium: 1 }, NONE],
    'the rolled Medium counts in round 1, and round 2 bought nothing new')
})
