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
function scriptFor({ findings, verify = () => UPHELD, sizeBucket = 'small' }) {
  return {
    detect: { baseRef: 'main', files: ['src/lib.rs'], spec: '', branch: 'feat/x', head: 'abc1234' },
    'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
    checkpoint: { runDir: '/store/.partial/run-A', error: '' },
    'log-run': { ok: true, error: '' },
    scout: { sizeBucket, lenses: ['naming'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
    gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
    // Only the first lens call yields findings; the loop-until-dry round then comes back empty.
    lens: ({ callIndex }) => ({ lens: 'naming', findings: callIndex === 0 ? findings : [] }),
    dedup: { groups: [] },
    verify,
    'verify-batch': ({ prompt }) => ({
      verdicts: [...prompt.matchAll(/--- FINDING (\d+) ---/g)].map(m => ({ index: Number(m[1]), ...UPHELD })),
    }),
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
