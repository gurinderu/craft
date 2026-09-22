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

test('review memory: a RETIRED dismissal leaves a tombstone marked DISMISSED, not resolved', async () => {
  // A dismissed prior (rejected/justified) whose carry-check finds the code around it unchanged is
  // retired — and it, too, is now remembered as a tombstone rather than dropped. But its origin is a
  // dismissal, not a fix: the marker must say `dismissed`, because a later round reads exactly that
  // to tell a re-raised dismissal from a genuine regression (see the downstream test below).
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
  assert.match(String(tomb.why), /dismissed in round 2/, 'and it is marked dismissed — the code never changed and nothing was fixed')
  assert.ok(!/resolved in round/.test(String(tomb.why)), 'never "resolved", which would be a false regression claim next round')
})

test('review memory: a returning DISMISSED defect is labelled re-raised, never a "REGRESSION ... resolved"', async () => {
  // The downstream half of the test above: a carried tombstone whose origin is a DISMISSAL (its why
  // carries the `dismissed` marker a real retirement now writes). A fresh finding at the same identity
  // has NOT regressed — nothing was ever fixed, and the code-changed case is handled by the separate
  // reopened path — so it must be named a re-raised dismissal, not a resolved defect that came back.
  const tomb = ledgerRow({ disposition: 'closed', severity: 'High', title: 'the dismissed defect', why: 'dismissed in round 1' })
  const { calls } = await runEngine('review', {
    args: {},
    script: scriptFor({
      findings: [finding('High', 51, { ruleId: 'ERR-001', title: 'the author dismissed this, and here it is again' })],
      priorRound: priorWith([tomb]),
    }),
  })
  const synth = calls.find(c => c.label === 'synthesis')
  assert.ok(synth, 'the run must reach synthesis, or nothing was tested')
  assert.match(synth.prompt, /a defect the author dismissed in round 1 has been re-raised/,
    'a re-raised dismissal is named as exactly that')
  assert.ok(!/REGRESSION: this exact defect was resolved/.test(synth.prompt),
    'and it is NOT mislabelled a regression that was resolved — nothing was fixed and nothing broke')
})

test('review memory: a returning defect that lands UNVERIFIED (floor-skipped) is still flagged a regression', async () => {
  // flagRegression once scanned only confirmed/suspected. But the unverified tier is exactly where a
  // returning defect lands when its verifier died or was floor-skipped — the run where the "it came
  // back" signal matters most. A resolved tombstone, and a fresh LOW finding at the same identity with
  // a NON-blocking rule (CPX-042 is not in CRITICAL_TIER_RULES) so verifyTier floor-skips it into
  // `unverified`, never confirmed.
  const tomb = ledgerRow({ disposition: 'closed', severity: 'High', ruleId: 'CPX-042', title: 'the fixed defect', why: 'resolved in round 1' })
  const run = await runEngine('review', {
    args: {},
    script: scriptFor({
      findings: [finding('Low', 51, { ruleId: 'CPX-042', title: 'it came back, but nothing verified it' })],
      priorRound: priorWith([tomb]),
    }),
  })
  const ledger = (filedRecord(run) || {}).ledger || []
  const row = ledger.find(e => e.tier === 'unverified' && e.ruleId === 'CPX-042')
  assert.ok(row, 'the returning Low finding is persisted as an unverified row')
  assert.match(String(row.why), /REGRESSION: this exact defect was resolved in round 1 and has reappeared/,
    'and the regression flag reaches the unverified tier, not only confirmed/suspected')
})

test('review memory: the regression log does not claim a verdict effect it does not have', async () => {
  // The flag is a human-facing annotation on `why`; the verdict counts a returning finding by its own
  // severity, exactly as a novel one. The log line used to say "not counted as new", asserting a
  // verdict discount that does not exist — it now states the annotation is verdict-neutral.
  const tomb = ledgerRow({ disposition: 'closed', severity: 'High', title: 'the fixed defect', why: 'resolved in round 1' })
  const { logs } = await runEngine('review', {
    args: {},
    script: scriptFor({
      findings: [finding('High', 51, { ruleId: 'ERR-001', title: 'it came back' })],
      priorRound: priorWith([tomb]),
    }),
  })
  const line = logs.find(l => /match a defect RESOLVED in an earlier round/.test(l))
  assert.ok(line, 'a regression is logged')
  assert.ok(!/not counted as new/.test(line), 'the log no longer claims the verdict discounts a regression')
  assert.match(line, /the verdict still counts each by its severity/, 'it states the flag is annotation-only')
})

test('review memory: carried tombstones are deduped by fingerprint — a recidivist writes one row, not one per cycle', async () => {
  // Two closed rows for the SAME defect (same file+symbol+ruleId → same fp) from two rounds, as a
  // repeat offender accumulates. Carried forward verbatim both would persist and the pile would grow a
  // row per cycle; deduped on carry, only the newest survives.
  const older = ledgerRow({ disposition: 'closed', why: 'resolved in round 1' })
  const newer = ledgerRow({ disposition: 'closed', why: 'resolved in round 2' })
  const run = await runEngine('review', {
    args: {},
    script: scriptFor({
      findings: [],
      priorRound: { found: true, round: 2, head: 'abc0000', ledgerCount: 2, priorFindings: 2, reason: '', ledger: [older, newer] },
    }),
  })
  const ledger = (filedRecord(run) || {}).ledger || []
  const tombs = ledger.filter(e => e.disposition === 'closed')
  assert.equal(tombs.length, 1, 'two same-fp tombstones collapse to one on carry-forward')
  assert.match(String(tombs[0].why), /round 2/, 'and the survivor is the NEWEST, not the oldest')
})

test('review memory: a revision bump skips the recidivism check for that transition rather than comparing incomparable fingerprints silently', async () => {
  // The prior round was produced under a DIFFERENT engine revision (sameEngineRevision:false, what the
  // loader reports after an upgrade). Its stored fp was computed under the old basis, so comparing it to
  // a fresh finding's new-basis fp would miss — silently — on the very run where a regression is most
  // likely. The guard turns that silent miss into a skip-with-a-log, and the memory rebuilds from here.
  const tomb = ledgerRow({ disposition: 'closed', severity: 'High', title: 'the closed defect', why: 'resolved in round 1' })
  const run = await runEngine('review', {
    args: {},
    script: scriptFor({
      findings: [finding('High', 51, { ruleId: 'ERR-001', title: 'it came back under new words' })],
      priorRound: priorWith([tomb], { sameEngineRevision: false }),
    }),
  })
  const synth = run.calls.find(c => c.label === 'synthesis')
  assert.ok(synth, 'the run must reach synthesis, or nothing was tested')
  assert.ok(!/REGRESSION/.test(synth.prompt), 'across a revision boundary the fingerprints are incomparable — no regression is claimed')
  assert.ok(!/re-raised/.test(synth.prompt), 'and no re-raise is claimed either')
  assert.ok(run.logs.some(l => /different engine revision/.test(l) && /skipped/.test(l)),
    'and the skip is ANNOUNCED — the silent miss is exactly what the guard removes')
  const ledger = (filedRecord(run) || {}).ledger || []
  assert.equal(ledger.filter(e => e.disposition === 'closed').length, 0,
    'the incomparable carried tombstone is dropped, not carried forward under a stale basis — a clean baseline')
})

test('review memory: within one engine revision the recidivism check still fires (the guard does not over-skip)', async () => {
  const tomb = ledgerRow({ disposition: 'closed', severity: 'High', title: 'the closed defect', why: 'resolved in round 1' })
  const { calls } = await runEngine('review', {
    args: {},
    script: scriptFor({
      findings: [finding('High', 51, { ruleId: 'ERR-001', title: 'it came back' })],
      priorRound: priorWith([tomb], { sameEngineRevision: true }),
    }),
  })
  const synth = calls.find(c => c.label === 'synthesis')
  assert.match(synth.prompt, /REGRESSION: this exact defect was resolved in round 1 and has reappeared/,
    'a matching revision compares fingerprints exactly as before — the guard fires only on a mismatch')
})

test('review memory: a resolved prior carrying an OLD-basis fp is tombstoned under the CURRENT basis, so its return still matches (finding 1)', async () => {
  // The transition round right after an engine bump: a LIVE prior loaded from a ledger written under the
  // OLD revision still carries its stored old-basis `fp`. When it resolves it must be minted into a
  // tombstone under THIS round's basis — otherwise a later same-revision round keys the recidivism check
  // on the stale hash (t.fp) while looking the returning defect up under the current one (fingerprint(f)),
  // the two never match, and the regression is missed in silence: the exact class the revision guard
  // removes, only shifted one round on. This is the two uncovered edges of finding 1+4's shared invariant
  // seen from the MINTING side — every tombstone-minting path (resolved and dismissed both route through
  // toTombstone) writes the current basis.
  const STALE = 'deadbeef'                                  // an old-basis fp, deliberately != fingerprint(identity)
  const identity = { file: 'src/lib.rs', symbol: 'g', ruleId: 'ERR-001' }
  assert.notEqual(fingerprint(identity), STALE, 'the fixture only means anything if the stale fp differs from the current one')
  const openPrior = { ...ledgerRow({ disposition: 'open', ruleId: 'ERR-001', title: 'to be fixed' }), fp: STALE }

  // Round A — the transition (sameEngineRevision:false). The prior resolves and is minted into a tombstone.
  const roundA = await runEngine('review', {
    args: {},
    script: scriptFor({
      findings: [],
      priorRound: priorWith([openPrior], { sameEngineRevision: false }),
      adjudicate: { status: 'resolved', note: 'fixed', attack: '', currentLine: 0 },
    }),
  })
  const ledgerA = (filedRecord(roundA) || {}).ledger || []
  const tomb = ledgerA.find(e => e.disposition === 'closed')
  assert.ok(tomb, 'the resolved prior leaves a tombstone')
  assert.equal(tomb.fp, fingerprint(identity), 'the tombstone is keyed under the CURRENT basis, not the carried old-basis fp')
  assert.notEqual(tomb.fp, STALE, 'the stale hash did not survive into the tombstone')

  // Round B — back on this revision (sameEngineRevision:true). The defect returns at the same identity.
  const roundB = await runEngine('review', {
    args: {},
    script: scriptFor({
      findings: [finding('High', 51, { ruleId: 'ERR-001', title: 'it came back under new words' })],
      priorRound: { found: true, round: 2, head: 'abc0000', ledgerCount: ledgerA.length, priorFindings: ledgerA.length, reason: '', ledger: ledgerA, sameEngineRevision: true },
    }),
  })
  const synth = roundB.calls.find(c => c.label === 'synthesis')
  assert.ok(synth, 'the run must reach synthesis, or nothing was tested')
  assert.match(synth.prompt, /REGRESSION: this exact defect was resolved/,
    'the returning defect matches the current-basis tombstone and is flagged — the silent miss is closed')
})

test('review memory: the COMBINED ledger (tombstones + live) is bounded under the copy-refusal border, not tombstones alone', async () => {
  // The finding this pins: LEDGER_TOMBSTONE_MAX capped tombstones ALONE, but the single-call copy of the
  // final record refuses on the WHOLE ledger (~170 entries). ~150 carried tombstones plus an ordinary
  // live load crossed that border and inverted the memory into a per-round full rescan. The assembler
  // must shed tombstones for the live rows so the combined ledger stays under the border.
  const tombs = Array.from({ length: 150 }, (_, i) =>
    ledgerRow({ disposition: 'closed', ruleId: `OLD-${i}`, symbol: `s${i}`, file: `src/f${i}.rs`, why: `resolved in round ${i + 1}` }))
  const fresh = Array.from({ length: 25 }, (_, i) =>
    finding('High', 100 + i, { ruleId: `NEW-${i}`, symbol: `n${i}`, file: `src/new${i}.rs`, title: `fresh defect ${i}` }))
  const run = await runEngine('review', {
    args: {},
    script: scriptFor({
      findings: fresh,
      priorRound: { found: true, round: 5, head: 'abc0000', ledgerCount: tombs.length, priorFindings: tombs.length, reason: '', ledger: tombs },
    }),
  })
  const ledger = (filedRecord(run) || {}).ledger || []
  assert.ok(ledger.length > 0, 'the run filed a ledger')
  assert.ok(ledger.length < 170, `the combined ledger (${ledger.length}) must stay under the ~170-entry copy-refusal border`)
  const live = ledger.filter(e => e.disposition !== 'closed').length
  const dead = ledger.filter(e => e.disposition === 'closed').length
  assert.equal(live, 25, 'every live finding is kept — it is the tombstones that are shed to make room')
  assert.ok(dead > 0 && dead < 150, `tombstones were shed for the live rows (kept ${dead} of 150)`)
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
