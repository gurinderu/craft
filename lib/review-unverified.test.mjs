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
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'

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

const UPHELD = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'ok' }
const REFUTES = { refuted: true, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'no' }

// A scripted run of the engine over one file's worth of findings. `verify` and `sizeBucket` are the
// two knobs the tests below turn; everything else is the minimum that lets the engine reach Verify.
function scriptFor({ findings, verify = () => UPHELD, sizeBucket = 'small', verifyBatch, priorRound } = {}) {
  return {
    detect: { baseRef: 'main', files: ['src/lib.rs'], spec: '', branch: 'feat/x', head: 'abc1234' },
    'prior-round': priorRound || { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
    checkpoint: { runDir: '/store/.partial/run-A', error: '' },
    'log-run': { ok: true, error: '' },
    scout: { sizeBucket, lenses: ['naming'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
    gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
    // Only the first lens call yields findings; the loop-until-dry round then comes back empty.
    lens: ({ callIndex }) => ({ lens: 'naming', findings: callIndex === 0 ? findings : [] }),
    dedup: { groups: [] },
    verify,
    'verify-batch': verifyBatch || (({ prompt }) => ({
      verdicts: [...prompt.matchAll(/--- FINDING (\d+) ---/g)].map(m => ({ index: Number(m[1]), ...UPHELD })),
    })),
    // Synthesis dies on purpose: the mechanical fallback report is the engine's OWN rendering, so
    // what it says about the tiers is the engine's behaviour and not a model's paraphrase.
    synthesis: null,
    '*': null,
  }
}

const verifyLabels = calls => calls.filter(c => /^verify/.test(c.label)).map(c => c.label)

// NOTE on what this one proves. The zero-agent routing predates this tier: `verifyTier` already sent
// Low/Info to `skip`. So the `deepEqual([])` here is a REGRESSION GUARD over behaviour that was
// already correct, not evidence of a change — removing the unverified tier leaves it passing. Only
// the log assertion below moves with the change. Said plainly so the test is not read as coverage it
// does not provide.
test('review: a Low finding buys no verification agent at all', async () => {
  const { calls, logs } = await runEngine('review', {
    args: {},
    script: scriptFor({ findings: [finding('Low', 10)] }),
  })
  assert.deepEqual(verifyLabels(calls), [], 'a Low finding must dispatch neither an individual nor a batch verifier')
  assert.ok(
    logs.some(l => /NOT VERIFIED/.test(l)),
    'and the run must SAY it skipped verification rather than pass over it silently',
  )
})

test('review: an unverified Low is reported as unverified, not as confirmed or suspected', async () => {
  const { report } = await runEngine('review', {
    args: {},
    script: scriptFor({ findings: [finding('Low', 10)] }),
  })
  assert.match(report, /## Unverified \(not checked\)/, 'the unchecked findings get their own section')
  assert.match(
    report,
    /no verifier was spent on them because a Low\/Info finding cannot change the verdict/,
    'and the section must state that they were not checked, and why',
  )
  const section = s => {
    const i = report.indexOf(`## ${s}`)
    if (i < 0) return ''
    const rest = report.slice(i + 1)
    const j = rest.indexOf('\n## ')
    return j < 0 ? rest : rest.slice(0, j)
  }
  assert.ok(!/src\/lib\.rs:10/.test(section('Confirmed')), 'an unchecked finding must not appear as Confirmed')
  assert.ok(!/src\/lib\.rs:10/.test(section('Suspected')), 'nor as Suspected — that tier means a verifier looked')
  assert.match(section('Unverified'), /src\/lib\.rs:10/, 'it must appear, though: skipping verification is not dropping it')
})

test('review: a High still gets its deciding pair, and buys the rest only on a split', async () => {
  // Unanimous pair → the escalation is not bought.
  const agreed = await runEngine('review', {
    args: {},
    script: scriptFor({ findings: [finding('High', 20)], sizeBucket: 'large' }),
  })
  assert.deepEqual(
    verifyLabels(agreed.calls).sort(),
    ['verify:src/lib.rs:20#auth', 'verify:src/lib.rs:20#c1'],
    'a High opens with exactly the cheap cull plus the authoritative vote',
  )

  // Split pair → the remaining culls are bought (verifyVotes is 3 at size `large`, so n1-1 = 2 more).
  const split = await runEngine('review', {
    args: {},
    script: scriptFor({
      findings: [finding('High', 20)],
      sizeBucket: 'large',
      verify: ({ opts }) => (/#auth$/.test(opts.label) ? REFUTES : UPHELD),
    }),
  })
  assert.deepEqual(
    verifyLabels(split.calls).sort(),
    ['verify:src/lib.rs:20#auth', 'verify:src/lib.rs:20#c1', 'verify:src/lib.rs:20#c2', 'verify:src/lib.rs:20#c3'],
    'a disagreement between the opening two must restore the full panel',
  )
})

test('review: the refutation rate is computed only over what was actually verified', async () => {
  // One High, refuted by a unanimous panel; three Low/Info nobody looked at. The rate must read 1
  // over 1 — not 1 over 4, which is what a denominator holding the unverified tier would report.
  const run = await runEngine('review', {
    args: {},
    script: scriptFor({
      findings: [finding('High', 20), finding('Low', 10), finding('Info', 40), finding('Low', 50)],
      verify: () => REFUTES,
    }),
  })
  const record = filedRecord(run)
  assert.ok(record, 'the outgoing record must be recoverable')
  assert.equal(record.verification.candidates, 1, 'only the High was ever judged')
  assert.equal(record.verification.confirmed, 0)
  assert.equal(record.verification.refuteRate, 1, 'one of one judged candidates was refuted')
  assert.equal(record.verification.unverified, 3, 'and the unjudged ones are counted, beside the denominator rather than in it')
})

// ---- the OTHER way into the tier: a batch verifier that never returned a verdict --------------
//
// Two deaths, and the harness tells them apart. A scripted answer of `null` is an agent that RETURNED
// nothing: `ragent` re-dispatches it, gives up, and the engine's `.then` walks a verdict list with no
// entry for the finding — the missing-index path, which marks it Suspected and says why. A scripted
// answer that THROWS rejects `ragent` itself, so the whole `.then` is skipped and the thunk's `.catch`
// runs. That second path is the one asserted here: it used to hand up to BATCH_SIZE Medium findings
// the tier that the report defines as "a verifier examined this and could not confirm it".
const THROWS = () => { throw new Error('batch verifier exploded') }

test('review: a batch verifier that THREW leaves its findings unverified, not suspected', async () => {
  const { report, logs, calls } = await runEngine('review', {
    args: {},
    script: scriptFor({ findings: [finding('Medium', 10), finding('Medium', 11)], verifyBatch: THROWS }),
  })
  // First: prove WHICH death this is, because the two are answered in different places and only one
  // of them was wrong. The harness's fake `agent` evaluates the scripted answer BEFORE it records the
  // call, so a throwing entry leaves no `verify-batch` call behind at all, while a `null` entry is
  // recorded twice (the dispatch and `ragent`'s one re-dispatch). Zero recorded calls is therefore the
  // signature of the thrown path — the one that reaches the thunk's `.catch`.
  const batchCalls = calls.filter(c => /verify-batch/.test(String(c.label)))
  assert.equal(batchCalls.length, 0, 'a throw is raised before the call is recorded — this is the .catch path, not the dead-agent one')

  const section = s => {
    const i = report.indexOf(`## ${s}`)
    if (i < 0) return ''
    const rest = report.slice(i + 1)
    const j = rest.indexOf('\n## ')
    return j < 0 ? rest : rest.slice(0, j)
  }
  assert.ok(!/src\/lib\.rs:1[01]/.test(section('Suspected')), 'a verifier that died never examined anything — Suspected would be a false claim of inspection')
  assert.match(section('Unverified'), /src\/lib\.rs:10/, 'the findings must still be reported, in the tier that says nothing checked them')
  assert.match(section('Unverified'), /src\/lib\.rs:11/, 'the whole group, not just its first member')
  assert.match(report, /died before returning/, 'and the report must say WHY they are unchecked')
  assert.ok(logs.some(l => /batch verifier for .* died/.test(l)), 'the death must also be logged')
  assert.match(report, /INCOMPLETE/, 'verification that did not run makes the verdict INCOMPLETE — it reaches notRun, not only the log')
})

test('review: a dead batch verifier is excluded from the verification denominator', async () => {
  const run = await runEngine('review', {
    args: {},
    script: scriptFor({ findings: [finding('Medium', 10), finding('Medium', 11)], verifyBatch: THROWS }),
  })
  const record = filedRecord(run)
  assert.ok(record, 'the outgoing record must be recoverable')
  assert.equal(record.verification.candidates, 0, 'nothing was judged, so the denominator is empty — not 2')
  assert.equal(record.verification.unverified, 2, 'both findings are counted beside the denominator')
  assert.ok(
    record.notRun.some(n => /verification of src\/lib\.rs/.test(n)),
    'and the run must name the verification that never happened',
  )
})

// ---- the re-review report has somewhere to put the tier ---------------------------------------
// The template a re-review synthesis is given is a DIFFERENT template, and it listed Resolved /
// Still-open / Regressed / New / Carried / Retired and no Unverified. The unverified findings were
// handed to the model in their own JSON block with no section to put them in — so on every re-review
// round the tier's destination was the model's improvisation.
const PRIOR = {
  found: true,
  round: 1,
  head: 'abc0000',
  ledgerCount: 1,
  priorFindings: 1,
  reason: '',
  ledger: [{
    stable_id: 'p1', severity: 'High', title: 'prior thing', file: 'src/lib.rs', line: 99,
    symbol: 'f', ruleId: '', why: 'w', fix: 'f', disposition: 'open', round: 1,
  }],
}

test('review: the re-review template carries the Unverified section too', async () => {
  const { calls } = await runEngine('review', {
    args: {},
    script: scriptFor({ findings: [finding('Low', 10)], priorRound: PRIOR }),
  })
  const synth = calls.find(c => c.label === 'synthesis')
  assert.ok(synth, 'the run must reach synthesis, or nothing was tested')
  assert.match(synth.prompt, /RE-REVIEW/, 'and it must be the re-review template that is being asserted about')
  assert.match(synth.prompt, /## Unverified \(not checked\)/, 'the re-review report needs the section, or the new tier has nowhere to go')
  assert.match(synth.prompt, /UNVERIFIED — NOT CHECKED \(JSON\)/, 'the data is handed over on this path as well')
})

test('review: a LOST finding — a live verifier that judged others and dropped this one — stays Suspected', async () => {
  // The one case on the whole verification path that must NOT become `unverified`. The verifier
  // ANSWERED: its verdict list is non-empty, it just carries no entry for index 0. An inspection
  // happened and lost a finding, which is a different fact from "no inspection happened", and the
  // discriminator between them is exactly this — a non-empty list missing an index.
  //
  // This test used to be written with `verifyBatch: () => null` and asserted Suspected for it. That
  // was the defect wearing a test: `null` is what `ragent` returns for a DEAD or timed-out agent,
  // which is the dominant death on this path, so the guard pinned "a dead agent is reported as
  // inspected". The row for `null` now lives in the death table below.
  const { report, calls } = await runEngine('review', {
    args: {},
    script: scriptFor({
      findings: [finding('Medium', 10), finding('Medium', 11)],
      // Index 1 is judged; index 0 is dropped. Live answer, one finding lost.
      verifyBatch: () => ({ verdicts: [{ index: 1, ...UPHELD }] }),
    }),
  })
  const batchCalls = calls.filter(c => /verify-batch/.test(String(c.label)))
  assert.equal(batchCalls.length, 1, 'a live answer is not re-dispatched')
  assert.match(report, /## Suspected \(needs confirmation\)/, 'a lost verdict stays Suspected')
  assert.match(report, /returned no verdict for this finding/, 'with the wording of its own path')
  assert.ok(!/NOT VERIFIED/.test(report.slice(report.indexOf('## Suspected'))), 'and must not borrow the dead-verifier wording')
})

test('review: an off-schema individual verdict must not DELETE a Critical by reading as a refutation', async () => {
  // The reviewer's own reproduction, executed. One Critical; the individual verifier answers with a
  // live object that is not a verdict. Before the shape guard the report said "no findings survived":
  // every absent boolean read as false, `citedLineMatches: false` set the tier to `refuted`, and the
  // refuted filter removed the finding from the run — while the record still counted it as a
  // candidate with refuteRate 1 and `notRun` stayed empty. A silent deletion of a Critical.
  const run = await runEngine('review', {
    args: {},
    script: scriptFor({ findings: [finding('Critical', 40)], verify: () => ({ ok: true, note: 'not a verdict' }) }),
  })
  const { report } = run
  assert.ok(!/no findings survived/.test(report), 'the finding must not vanish from the run')
  assert.match(report, /## Unverified/, 'it carries the tier that says nothing checked it')
  assert.match(report, /src\/lib\.rs:40\b/, 'and it is still named in the report')
  const record = filedRecord(run)
  assert.equal(record.verification.candidates, 0, 'it is OUT of the refutation denominator')
  assert.ok(!record.verification.refuteRate, 'so no refutation rate is claimed over it')
  assert.ok((record.notRun || []).some(n => /verification of/.test(n)), 'and the verification that never happened reaches notRun')
  assert.match(report, /INCOMPLETE/, 'so the verdict cannot read as a clean pass')
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


for (const d of DEATHS) {
  test(`review invariant: ${d.name} → unverified, out of the denominator, in notRun`, async () => {
    const run = await runEngine('review', { args: {}, script: scriptFor(d.script) })
    const { report } = run
    const section = s => {
      const i = report.indexOf(`## ${s}`)
      if (i < 0) return ''
      const rest = report.slice(i + 1)
      const j = rest.indexOf('\n## ')
      return j < 0 ? rest : rest.slice(0, j)
    }
    for (const line of d.lines) {
      const at = new RegExp(`src/lib\\.rs:${line}\\b`)
      assert.ok(!at.test(section('Confirmed')), `line ${line}: a death must not read as Confirmed`)
      assert.ok(!at.test(section('Suspected')), `line ${line}: Suspected asserts a verifier LOOKED — a death did not`)
      assert.ok(!at.test(section('New')), `line ${line}: nor as a live new finding`)
      assert.match(section('Unverified'), at, `line ${line}: it must be reported, in the tier that says nothing checked it`)
    }
    const record = filedRecord(run)
    assert.ok(record, 'the outgoing record must be recoverable')
    assert.equal(record.verification.candidates, 0, 'nothing was judged, so the refutation denominator is empty')
    assert.equal(record.verification.unverified, d.lines.length, 'every dead finding is counted beside the denominator, not inside it')
    assert.ok(
      (record.notRun || []).some(n => /verification of/.test(n)),
      'and the verification that never happened must reach notRun — the log is not the verdict',
    )
    assert.match(report, /INCOMPLETE/, 'so the verdict reads as incomplete rather than as a clean pass')
    // The row reached ITS OWN branch, not a neighbour's: the branch writes this phrase into the
    // finding's `why`, and no two distinct branches write the same one.
    assert.ok(section('Unverified').includes(d.branch), `the death must be reported by its own branch (${d.branch})`)
  })
}

test('the death table reaches as many DISTINCT code branches as it has distinct branch phrases', () => {
  // The guard on the guard. Rows are cheap to add and a new row that lands on an existing branch
  // grows the table's apparent coverage without growing its real coverage — which is exactly how the
  // first version of this table came to have six rows over three branches.
  const branches = new Set(DEATHS.map(d => d.branch))
  assert.equal(branches.size, 6, 'six distinct death branches are exercised')
  assert.equal(DEATHS.length, 7, 'by seven rows — the seventh shares the empty-vote branch by construction (parallel() maps a throw to null)')
})

test('review invariant: an unverified prior keeps its tier across the round boundary', async () => {
  // The tier used to be locked inside the round that minted it. A prior ledger entry carrying
  // `tier: 'unverified'` went through adjudication like any other prior, and the default on a dead
  // adjudicator is `stillOpen` — which renders under "Still open" and FEEDS `rereviewVerdict`. So a
  // High nothing had ever checked became a gating still-open finding after exactly one hop: the same
  // substitution of unchecked for examined, one round later.
  const prior = {
    found: true, round: 1, head: 'abc0000', ledgerCount: 1, priorFindings: 1, reason: '',
    ledger: [{
      fp: 'u1', severity: 'High', title: 'never checked', file: 'src/lib.rs', line: 77,
      symbol: 'g', ruleId: '', why: 'w', fix: 'f', disposition: 'open', tier: 'unverified', round: 1,
    }],
  }
  const { report, logs } = await runEngine('review', {
    args: {},
    script: scriptFor({ findings: [], priorRound: prior }),
  })
  const section = s => {
    const i = report.indexOf(`## ${s}`)
    if (i < 0) return ''
    const rest = report.slice(i + 1)
    const j = rest.indexOf('\n## ')
    return j < 0 ? rest : rest.slice(0, j)
  }
  assert.ok(!/src\/lib\.rs:77/.test(section('🔴 Still open')), 'an unchecked prior must not render as a live still-open finding')
  assert.match(section('Unverified'), /src\/lib\.rs:77/, 'it must still be reported, in the tier that says nothing checked it')
  assert.match(report, /STILL NOT VERIFIED/, 'and the report must say it is carried unchecked')
  assert.ok(!/⛔ Block/.test(report), 'a finding no verifier ever judged must not gate the verdict')
  assert.ok(logs.some(l => /carried forward as unverified/.test(l)), 'and the carry-forward is logged')
})

test('review invariant: notRun carries no error text and no run-specific path', async () => {
  // `notRun` is ranked by EXACT STRING in lib/analyze-runs.mjs to surface repeated fragility. An
  // entry carrying an exception message is unique per run, fills the ranking with count-1 rows and
  // sinks the real repeats — the same argument the uncovered-files ranking already records.
  const run = await runEngine('review', {
    args: {},
    script: scriptFor({ findings: [finding('Medium', 10)], verifyBatch: () => { throw new Error('UNIQUE-ERROR-TEXT-7f3a') } }),
  })
  const record = filedRecord(run)
  const notRun = (record.notRun || []).join('\n')
  assert.match(notRun, /verification of/, 'the death is named')
  assert.ok(!/UNIQUE-ERROR-TEXT-7f3a/.test(notRun), 'but the verbatim error text stays out of the ranked string')
})

// ---- the round chain is for TOP-LEVEL reviews only ---------------------------------------------
// The entry condition for reading the prior round was narrowed to `!freshArg` alone, and rightly:
// the old `branch && head` guard made the whole re-review memory conditional on a model filling two
// fields, so a `detect` agent that answered without them turned a continuation into a silent "first
// review". But the chain is keyed on (project, branch), and `rust-audit` fans out one nested
// `review` per crate through `parallel` — concurrent siblings that share both. Unconditional entry
// therefore put every sibling on ONE chain: each reads whichever sibling filed last as its own
// previous round, inherits a ledger of another crate's findings, and files a row the next top-level
// review can pick up as its predecessor.
//
// The decision, so it is not re-derived later: A NESTED CHILD DOES NOT ENTER THE ROUND CHAIN — not
// as a reader and not as a candidate. A per-crate child is one slice of its parent's single pass,
// not a round of its own, so there is nothing for it to continue; the parent run is the thing that
// has a history. Both halves are needed, and they fail differently: without the reader half the
// siblings collide with each other, and without the candidate half a later top-level review adopts
// a crate child's ledger as the whole repository's prior round.
test('review: a nested child run does not read the round chain', async () => {
  const PRIOR = {
    found: true, round: 3, head: 'abc0000', ledgerCount: 1, priorFindings: 1, reason: '',
    ledger: [{
      fp: 'n1', severity: 'High', title: 'a sibling crate\'s finding', file: 'other/src/lib.rs', line: 9,
      symbol: 'h', ruleId: '', why: 'w', fix: 'f', disposition: 'open', tier: 'confirmed', round: 3,
    }],
  }
  const { report, calls, logs } = await runEngine('review', {
    args: { _via: 'rust-audit' },
    script: scriptFor({ findings: [], priorRound: PRIOR }),
  })
  assert.ok(!calls.some(c => /prior-round/.test(String(c.label))),
    'a child of a fan-out must not read the chain at all — its siblings share its (project, branch)')
  assert.ok(!/other\/src\/lib\.rs/.test(report),
    'and must not inherit a sibling crate\'s ledger as its own prior round')
  assert.ok(logs.some(l => /nested/i.test(l) && /round chain/.test(l)),
    'and the skip is stated, not silent — a silent skip is the defect the `!freshArg` widening fixed')
})

test('review invariant: an unverified finding is never absorbed into a live prior — it neither disappears nor gates', async () => {
  // ABSORPTION WAS BLIND TO THE TIER. This branch is the first to route the unverified track through
  // absorption at all (trunk sent only confirmed and suspected), and absorption writes the finding
  // onto the host prior's `why` — which absorbedPromptBlock then hands the next adjudicator with the
  // sentence "resolved requires that every one of them is gone too". So a High that NOTHING checked
  // vanished from the Unverified section into a prior's description and, from there, held that prior
  // open and fed the re-review verdict: unchecked gating the verdict, which is the one substitution
  // this tier exists to end. The recorded justification covered only an unverified LOW duplicating a
  // live prior; a dead verifier's Critical and High travel the same road.
  const prior = {
    found: true, round: 1, head: 'abc0000', ledgerCount: 1, priorFindings: 1, reason: '',
    ledger: [{
      fp: 'p1', severity: 'High', title: 'the tracked prior', file: 'src/lib.rs', line: 50,
      symbol: 'g', ruleId: 'ERR-001', why: 'the prior rationale', fix: 'f', disposition: 'open', tier: 'confirmed', round: 1,
    }],
  }
  const { report, logs } = await runEngine('review', {
    args: {},
    script: scriptFor({
      // Same file+ruleId as the prior, so findCarrier matches it. The verifier dies, so the finding
      // carries the unverified tier rather than a judgement.
      findings: [finding('High', 51, { ruleId: 'ERR-001', title: 'unchecked at the same site' })],
      verify: () => null,
      priorRound: prior,
    }),
  })
  assert.match(report, /## Unverified/, 'the unverified section must exist')
  const unver = report.slice(report.indexOf('## Unverified'))
  assert.match(unver, /src\/lib\.rs:51\b/, 'the unchecked finding stays in its own tier — it does not disappear into the prior')
  assert.ok(!/also reported at src\/lib\.rs:51/.test(report), 'and it is NOT written onto the prior, where it would become an obligation for "resolved"')
  assert.ok(
    logs.some(l => /NOT absorbed into the prior/.test(l)),
    'the refusal to absorb is stated, not silent',
  )
  assert.ok(
    !logs.some(l => /absorbed 1 new finding/.test(l)),
    'nothing was absorbed this round',
  )
  assert.ok(unver.includes('already tracked by a still-live prior'), 'the reader is told the site is already tracked — without the prior inheriting the obligation')
})

test('review: the synthesis prompt names BOTH roads into the unverified tier, not just the cheap one', async () => {
  // The synthesizer is the reader the single-sentence preamble was consolidated for: "a reader who is
  // told only the first reason will read a dead verifier's findings as cheap ones". The VERDICT RULE
  // block told it exactly one reason — "no verifier was spent: Low/Info cannot move the verdict" —
  // so the one model that decides the verdict was the one reader given the half-truth. A Critical
  // whose verifier died carries this tier, and the block must say so.
  const run = await runEngine('review', {
    args: {},
    script: scriptFor({ findings: [finding('Critical', 60)], verify: () => null }),
  })
  const synth = run.calls.find(c => c.label === 'synthesis')
  assert.ok(synth, 'the synthesis agent must have been dispatched')
  const rule = synth.prompt.slice(synth.prompt.indexOf('VERDICT RULE'))
  assert.ok(/died before returning one|verifier .*died/i.test(rule), 'the verdict rule must name the dead-verifier road into the tier')
  assert.ok(/Critical or High can carry this tier/.test(rule), 'and say that a gating severity can arrive there')
})

test('review: a critic follow-up lens that DIED is recorded as not run, exactly like one skipped for budget', async () => {
  // A SILENT REFUSAL BESIDE A LOUD ONE. A follow-up lens skipped for budget wrote a notRun entry and
  // made the review INCOMPLETE; a follow-up lens that was dispatched and DIED was swallowed by
  // `.filter(Boolean)` — no entry, no marker. "The critic said run it and it died" is not a cleaner
  // outcome than "the critic said run it and there was no budget"; it is the same coverage hole, and
  // the only one of the two a re-run can fix.
  const base = scriptFor({ findings: [finding('Medium', 70)] })
  const run = await runEngine('review', {
    args: {},
    script: {
      ...base,
      // `large` puts the completeness critic in scope without the security floor, which would fill
      // the plan with EVERY lens and leave the critic no candidate to ask for.
      scout: { ...base.scout, sizeBucket: 'large', lenses: ['safety'], securitySensitive: false },
      // The first-round lens answers; the critic's follow-up lens dies.
      lens: ({ opts, callIndex }) => {
        const label = String(opts?.label ?? '')
        if (/ \(critic\)$/.test(label)) return null
        const lens = label.replace(/^lens:[^:]*:/, '')
        return { lens, findings: callIndex === 0 ? [finding('Medium', 70)] : [] }
      },
      critic: { missingLenses: ['tests'], notes: '' },
    },
  })
  const record = filedRecord(run)
  assert.ok(record, 'the outgoing record must be recoverable')
  assert.ok(
    (record.notRun || []).some(n => /critic follow-up lens tests/.test(n)),
    'the dead follow-up lens must reach notRun by name',
  )
  assert.match(run.report, /INCOMPLETE/, 'and the verdict must read as incomplete')
  assert.ok(run.logs.some(l => /died before returning findings/.test(l)), 'and it must be said out loud')
})
