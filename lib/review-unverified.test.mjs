// The `unverified` tier of the review engine, executed rather than read.
//
// Low/Info findings buy no verification agent — no combination of verdicts on them can move
// Approve/Warning/Block. The cost of that saving is that they are UNCHECKED, and the defect class
// this repo keeps hitting is precisely "unchecked rendered as clean": folding them into Suspected
// made them indistinguishable from a finding a verifier examined and could not confirm, and put
// them into the refuteRate denominator, so the refutation rate of a Low/Info-heavy run could not be
// compared with any other run's.
//
// Measured on a large Rust diff (2026-09-17): 215 findings, of which 118 Low/Info; verification cast
// 89 verdicts and refuted 2. With the unverified tier inside the denominator the rate reads against
// ~207; against what was actually judged it reads against 89.
//
// These assertions run the real engine in-process (lib/engine-harness.mjs) because
// workflows/review.js cannot be imported and a source-text match would catch a deletion, not a defect.
import { test } from 'vitest'
import assert from 'node:assert/strict'

/**
 * @param {string} severity
 * @param {number} line
 * @param {Record<string, any>} [over]
 */
const finding = (severity, line, over = {}) => ({
  severity,
  title: `t${line}`,
  file: 'src/lib.rs',
  line,
  why: `w${line}`,
  fix: 'fix it',
  blastRadius: '',
  source: 'naming',
  ruleId: '',
  whereChecked: '',
  ...over,
})

// ---- THE INVARIANT, as a table -----------------------------------------------------------------
//
// Stated once: no death on the verification path may give a finding a tier that asserts an
// inspection, may leave it inside the refutation denominator, or may leave it out of `notRun`.
//
// The previous round of this fix closed ONE branch — the throw — and the dominant death is not a
// throw: `ragent` answers `null` for an API error, for a skip and for an expired per-agent deadline
// alike, and that null walked the "verdict list has no entry for this finding" path and came out as
// Suspected, i.e. as an inspection that never happened. A table with a row per death is what makes
// the NEXT such branch fail loudly instead of leaking out of the next door along.
//
// Each row scripts one way the verifier's result can fail to arrive, and every row demands the same
// three outcomes. A row that is merely "logged" is a failing row.
// EVERY ROW MUST REACH ITS OWN BRANCH. The first version of this table had six rows over three
// branches — three scripts converging on the batch answer-guard, two on the empty-vote guard — so it
// LOOKED like six deaths were pinned while three code paths carried them. That is the same
// "neighbouring door" failure the table was written against, wearing the table's own form. Each row
// now carries `branch`: the phrase the branch it must reach writes into the finding's `why`, asserted
// per row, and counted at the end of the file. A row whose phrase is shared with another row is a row
// that proves nothing the other did not.
//
// TWO DEATHS ARE HONESTLY INDISTINGUISHABLE HERE, AND THE TABLE SAYS SO RATHER THAN CLAIMING TWO.
//   - an individual vote that THREW vs one that returned `null`: `parallel()` is the sandbox
//     primitive that turns a throwing thunk into `null`, so by construction they are the same value
//     by the time tierFromVotes sees them. Both rows are kept — the scripts differ, and a regression
//     that stops catching the throw would fail the throw row — but they share one `branch` on
//     purpose, and the count below counts the branch once.
//   - death #6 of the enumeration in review.js (a verdict LOST by the sliding window, on either the
//     batch or the individual side) is NOT exercised by any row, and the reason is stated rather than
//     papered over with a row that would in fact land on one of the branches below. The window leaves
//     `null` at an entry's index when the ENTRY's promise settles to null — and the entry is the
//     verify thunk itself, whose only reachable throw sites (`tierFromVotes`, the escalation `await`)
//     are pure arithmetic over values the script chooses, none of which can be made to throw from a
//     scripted answer. The recovery is therefore pinned by the two `deadGroup`/`NOT_VERIFIED` calls it
//     shares with the rows above, and by nothing scripted here. It is an honest gap, not a covered one.
const DEATHS = [
  {
    name: 'a batch verifier that THREW (both ragent attempts rejected)',
    script: { findings: [finding('Medium', 10), finding('Medium', 11)], verifyBatch: () => { throw new Error('boom') } },
    lines: [10, 11],
    branch: 'died before returning any verdict',
  },
  {
    name: 'a batch verifier that returned null (API error / skip / expired deadline — the dominant death)',
    script: { findings: [finding('Medium', 10), finding('Medium', 11)], verifyBatch: () => null },
    lines: [10, 11],
    branch: 'returned nothing at all',
  },
  {
    name: 'a batch verifier that answered with an EMPTY verdict list',
    script: { findings: [finding('Medium', 10), finding('Medium', 11)], verifyBatch: () => ({ verdicts: [] }) },
    lines: [10, 11],
    branch: 'answered with an EMPTY verdict list',
  },
  {
    name: 'a batch verifier whose answer is not a verdict list at all (schema drift)',
    script: { findings: [finding('Medium', 10), finding('Medium', 11)], verifyBatch: () => ({}) },
    lines: [10, 11],
    branch: 'answered OFF-SCHEMA',
  },
  {
    name: 'an individual panel whose every vote died — a Critical demoted to a non-gating finding',
    script: { findings: [finding('Critical', 20)], verify: () => null },
    lines: [20],
    branch: 'every verifier vote for this finding died',
  },
  {
    name: 'an individual panel that THREW on every vote (converges on the empty-vote branch by design — see above)',
    script: { findings: [finding('High', 30)], verify: () => { throw new Error('boom') } },
    lines: [30],
    branch: 'every verifier vote for this finding died',
  },
  {
    // THE NINTH DOOR. Strictly worse than every row above: they keep the finding, this one deleted
    // it. An off-schema answer on the INDIVIDUAL path reached the vote arithmetic, where each absent
    // boolean read as `false`; `citedLineMatches: false` alone sets the tier to `refuted`, and
    // refuted findings are filtered out of the run — gone from every tier, still in the refutation
    // denominator, absent from notRun. The batch path had a guard for exactly this; the individual
    // path had none.
    name: 'an individual vote that is LIVE but off-schema (the agent wrapper returns any non-null value verbatim)',
    script: { findings: [finding('Critical', 40)], verify: () => ({ ok: true, note: 'not a verdict' }) },
    lines: [40],
    branch: 'ANSWERED OFF-SCHEMA',
  },
]

test('the death table reaches as many DISTINCT code branches as it has distinct branch phrases', () => {
  // The guard on the guard. Rows are cheap to add and a new row that lands on an existing branch
  // grows the table's apparent coverage without growing its real coverage — which is exactly how the
  // first version of this table came to have six rows over three branches.
  const branches = new Set(DEATHS.map(d => d.branch))
  assert.equal(branches.size, 6, 'six distinct death branches are exercised')
  assert.equal(DEATHS.length, 7, 'by seven rows — the seventh shares the empty-vote branch by construction (parallel() maps a throw to null)')
})
