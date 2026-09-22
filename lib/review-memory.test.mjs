// The re-review MEMORY, executed rather than read.
//
// A finding carries a hash identity (`fp`), and it is now anchored on file + normalizeSymbol(symbol)
// + ruleId — not on the natural-language title, which two lens agents rarely word the same way
// (matchesPrior on the old, title-anchored basis recognised 2 of 59 re-discoveries). The fixed
// anchor is spent on ONE capability the engine did not have: telling a defect's RETURN from a
// novelty. A resolved/retired prior leaves a lightweight `disposition:'closed'` TOMBSTONE in the
// ledger; a later round matches a fresh finding's fingerprint against those tombstones and flags a
// hit as a regression.
//
// These assertions run the real engine in-process (lib/engine-harness.mjs) because
// workflows/review.js cannot be imported and a source-text match would catch a deletion, not a defect.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'
import { fingerprint } from './run-record.mjs'

// A fresh lens finding. `symbol` is set explicitly: the fingerprint keys on it, so a test that means
// two findings to share an identity must give them the same symbol.
const finding = (severity, line, over = {}) => ({
  severity, title: `t${line}`, file: 'src/lib.rs', line, why: `w${line}`, fix: 'fix it',
  blastRadius: '', source: 'safety', ruleId: '', symbol: 'g', whereChecked: '', ...over,
})

// A prior-round ledger row (the 11 required LEDGER_ITEM fields), with `fp` computed the way the
// engine computes it, so a fresh finding sharing file+symbol+ruleId hashes to the same value.
const ledgerRow = over => {
  const base = { file: 'src/lib.rs', line: 50, symbol: 'g', severity: 'Medium', tier: 'confirmed', disposition: 'open', source: 'safety', ruleId: 'ERR-001', title: 'a prior defect', why: 'w', ...over }
  return { fp: fingerprint(base), ...base }
}

const priorWith = (ledger, over = {}) => ({
  found: true, round: 1, head: 'abc0000', ledgerCount: ledger.length, priorFindings: ledger.length, reason: '', ledger, ...over,
})

const UPHELD = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'ok' }

// The minimum script that reaches Verify/Adjudicate on a re-review. `adjudicate` and `carry` are the
// two knobs the tombstone tests turn; both may be a function of the call so a fixture can answer per
// finding (the label carries `:file:line`).
function scriptFor({ findings = [], priorRound, adjudicate, carry, verify = () => UPHELD } = {}) {
  return {
    detect: { baseRef: 'main', files: ['src/lib.rs'], spec: '', branch: 'feat/x', head: 'abc1234' },
    'prior-round': priorRound || { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
    checkpoint: { runDir: '/store/.partial/run-A', error: '' },
    'log-run': { ok: true, error: '' },
    scout: { sizeBucket: 'small', lenses: ['safety'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
    gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
    lens: ({ callIndex }) => ({ lens: 'safety', findings: callIndex === 0 ? findings : [] }),
    dedup: { groups: [] },
    verify,
    'verify-batch': ({ prompt }) => ({ verdicts: [...prompt.matchAll(/--- FINDING (\d+) ---/g)].map(m => ({ index: Number(m[1]), ...UPHELD })) }),
    adjudicate: adjudicate || { status: 'still-open', note: '', attack: '', currentLine: 50 },
    redteam: { defeated: false, attack: '' },
    carry: carry || { changed: false, reason: 'unchanged' },
    // Synthesis dies on purpose: the mechanical fallback is the engine's OWN rendering. Its dispatch
    // is still recorded with the full prompt, which is where the CONFIRMED JSON (and any REGRESSION
    // note appended to a finding's `why`) becomes assertable.
    synthesis: null,
    '*': null,
  }
}

const labelled = (calls, re) => calls.filter(c => re.test(String(c.label))).map(c => c.label)

test('review memory: a fresh finding matching a prior tombstone is flagged REGRESSION, and the tombstone is not adjudicated', async () => {
  const tomb = ledgerRow({ disposition: 'closed', severity: 'High', title: 'the closed defect', why: 'resolved in round 1' })
  const { calls } = await runEngine('review', {
    args: {},
    script: scriptFor({
      // Same file+symbol+ruleId as the tombstone → same fingerprint. A different title on purpose:
      // identity no longer rides on the title.
      findings: [finding('High', 51, { ruleId: 'ERR-001', title: 'it came back under new words' })],
      priorRound: priorWith([tomb]),
    }),
  })
  // The carve-out: a `disposition:'closed'` row is pulled BEFORE the settled/toCheck split, so it is
  // never sent to the adjudicator (there is nothing to judge at a closed site). Without the carve-out
  // it would fall into toCheck and dispatch `adjudicate:src/lib.rs:50`.
  assert.deepEqual(labelled(calls, /^adjudicate:/), [], 'a tombstone must never reach the adjudicator')
  assert.deepEqual(labelled(calls, /^carry:/), [], 'nor the carry-check')

  const synth = calls.find(c => c.label === 'synthesis')
  assert.ok(synth, 'the run must reach synthesis, or nothing was tested')
  assert.match(synth.prompt, /REGRESSION: this exact defect was resolved in round 1 and has reappeared/,
    'the returning defect must be marked a regression, carrying the round it was resolved in')
  assert.match(synth.prompt, /src\/lib\.rs/, 'and the fresh finding itself is handed to synthesis')
})

test('review memory: an ad-hoc finding (no ruleId) gets no tombstone check — no signal beats a fuzzy one', async () => {
  // A tombstone with no ruleId, and a fresh finding with no ruleId at the same site. Neither is keyed,
  // so nothing is flagged: the honest answer for a finding with no stable identity is silence.
  const tomb = ledgerRow({ disposition: 'closed', ruleId: '', severity: 'High', why: 'resolved in round 1' })
  const { calls } = await runEngine('review', {
    args: {},
    script: scriptFor({
      findings: [finding('High', 51, { ruleId: '' })],
      priorRound: priorWith([tomb]),
    }),
  })
  const synth = calls.find(c => c.label === 'synthesis')
  assert.ok(synth)
  assert.ok(!/REGRESSION/.test(synth.prompt), 'a finding with no ruleId has no exact identity, so it is not flagged')
})

test('review memory: a RESOLVED prior leaves a closed tombstone in the ledger, carrying the round it closed in', async () => {
  const open = ledgerRow({ severity: 'Medium', disposition: 'open', title: 'to be fixed' })
  const run = await runEngine('review', {
    args: {},
    script: scriptFor({
      findings: [],
      priorRound: priorWith([open]),                    // round 1 → this run is round 2
      adjudicate: { status: 'resolved', note: 'fixed', attack: '', currentLine: 0 },
    }),
  })
  const ledger = (filedRecord(run) || {}).ledger || []
  const tomb = ledger.find(e => e.disposition === 'closed')
  assert.ok(tomb, 'the resolved prior does not vanish — it leaves a tombstone')
  assert.equal(tomb.ruleId, 'ERR-001', 'the tombstone keeps the identity fields the recidivism check needs')
  assert.match(String(tomb.why), /resolved in round 2/, 'and a bare round marker as its why, not the original rationale')
  assert.ok(!ledger.some(e => e.disposition === 'open'), 'the resolved prior is not also re-persisted as a live row')
})

test('review memory: a RETIRED dismissal also leaves a tombstone', async () => {
  // A dismissed prior (rejected/justified) whose carry-check finds the code around it unchanged is
  // retired — and it, too, is now remembered as a tombstone rather than dropped.
  const dismissed = ledgerRow({ severity: 'Medium', disposition: 'rejected', title: 'author dismissed this' })
  const run = await runEngine('review', {
    args: {},
    script: scriptFor({
      findings: [],
      priorRound: priorWith([dismissed]),
      carry: { changed: false, reason: 'code around it is unchanged' },
    }),
  })
  const ledger = (filedRecord(run) || {}).ledger || []
  const tomb = ledger.find(e => e.disposition === 'closed')
  assert.ok(tomb, 'a retired dismissal leaves a tombstone, not silence')
  assert.match(String(tomb.why), /resolved in round 2/)
})

test('review memory: a tombstone persists across a quiet round — it is not lost on a clean re-review', async () => {
  // Round A: one prior resolves, leaving a tombstone.
  const open = ledgerRow({ severity: 'Medium', disposition: 'open' })
  const roundA = await runEngine('review', {
    args: {},
    script: scriptFor({
      findings: [],
      priorRound: priorWith([open]),
      adjudicate: { status: 'resolved', note: 'fixed', attack: '', currentLine: 0 },
    }),
  })
  const ledgerA = (filedRecord(roundA) || {}).ledger || []
  assert.equal(ledgerA.filter(e => e.disposition === 'closed').length, 1, 'round A produced exactly one tombstone')

  // Round B: fed round A's ledger and NOTHING else — no fresh findings, nothing to adjudicate. Without
  // the early-exit guard the run would short-circuit and file no ledger; without the `...priorTombstones`
  // carry it would file an empty one. Either way the memory would evaporate on the first quiet round.
  const roundB = await runEngine('review', {
    args: {},
    script: scriptFor({
      findings: [],
      priorRound: { found: true, round: 2, head: 'abc0000', ledgerCount: ledgerA.length, priorFindings: ledgerA.length, reason: '', ledger: ledgerA },
    }),
  })
  const ledgerB = (filedRecord(roundB) || {}).ledger || []
  const tomb = ledgerB.find(e => e.disposition === 'closed')
  assert.ok(tomb, 'the tombstone survives a round that found and adjudicated nothing')
  assert.match(String(tomb.why), /resolved in round 2/, 'and keeps its ORIGINAL round marker, not the current round')
  assert.deepEqual(labelled(roundB.calls, /^adjudicate:/), [], 'the carried tombstone is still never adjudicated')
})
