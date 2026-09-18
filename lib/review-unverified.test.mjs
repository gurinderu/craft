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
const DEATHS = [
  {
    name: 'a batch verifier that THREW (both ragent attempts rejected)',
    script: { findings: [finding('Medium', 10), finding('Medium', 11)], verifyBatch: () => { throw new Error('boom') } },
    lines: [10, 11],
  },
  {
    name: 'a batch verifier that returned null (API error / skip / expired deadline — the dominant death)',
    script: { findings: [finding('Medium', 10), finding('Medium', 11)], verifyBatch: () => null },
    lines: [10, 11],
  },
  {
    name: 'a batch verifier that answered with an EMPTY verdict list',
    script: { findings: [finding('Medium', 10), finding('Medium', 11)], verifyBatch: () => ({ verdicts: [] }) },
    lines: [10, 11],
  },
  {
    name: 'a batch verifier whose answer is not a verdict list at all (schema drift)',
    script: { findings: [finding('Medium', 10), finding('Medium', 11)], verifyBatch: () => ({}) },
    lines: [10, 11],
  },
  {
    name: 'an individual panel whose every vote died — a Critical demoted to a non-gating finding',
    script: { findings: [finding('Critical', 20)], verify: () => null },
    lines: [20],
  },
  {
    name: 'an individual panel that THREW on every vote',
    script: { findings: [finding('High', 30)], verify: () => { throw new Error('boom') } },
    lines: [30],
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
  })
}

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
