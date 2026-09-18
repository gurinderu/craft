// What a Medium verification costs once the verdict is already Block, executed rather than reasoned
// about.
//
// The measured shape (one large Rust review): 215 findings, 78 of them Medium; verification was 79%
// of the run's wall clock across 125 agents. Medium is the entire batched population, and
// `reviewVerdict` is a three-line rule under which a confirmed Critical or High makes every Medium
// verdict-neutral. `verifyTier` already refuses to spend a verifier on Low/Info for exactly that
// reasoning; this carries it to the tier where the cost is.
//
// THESE ASSERTIONS ARE CLOCK-FREE. The harness's fake agent answers instantly, so nothing here could
// measure a duration honestly. The observable is the one that converts to wall clock: HOW MANY batch
// verifiers a phase dispatches, and — the half that matters more — what the findings it did not
// dispatch are reported as.
//
// THE POPULATION IS LARGE ON PURPOSE. The verification window has no barrier: individual and batch
// entries overlap, and with a small population both tiers are dispatched in the same pump, so the
// floor cannot have been raised yet and every batch is legitimately bought. The saving exists
// precisely in the situation that was measured — an individual panel heavier than the window, behind
// which the batches queue. A test on three findings would prove the opposite of the real case.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'
import { VERIFY_WINDOW_AGENTS } from './review-waves.mjs'

const finding = (severity, line) => ({
  severity,
  title: `${severity.toLowerCase()}-${line}`,
  file: 'src/lib.rs',
  line,
  why: `w${line}`,
  fix: 'fix it',
  blastRadius: '',
  source: 'naming',
  ruleId: '',
  whereChecked: '',
})

// Enough Critical weight (2 agents each) to fill the window several times over, so the Medium
// batches really do queue behind them.
const CRITICALS = Array.from({ length: VERIFY_WINDOW_AGENTS }, (_unused, i) => finding('Critical', 100 + i))
const MEDIUM_GROUPS = 2
const MEDIUMS = Array.from({ length: MEDIUM_GROUPS * 6 }, (_unused, i) => finding('Medium', 300 + i))

const CONFIRMS = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'stands' }
const REFUTES = { refuted: true, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'no' }

function scriptFor(individualVote) {
  return {
    detect: { baseRef: 'main', files: ['src/lib.rs'], spec: '', branch: 'feat/x', head: 'abc1234' },
    'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
    checkpoint: { runDir: '/store/.partial/run-A', error: '' },
    'log-run': { ok: true, error: '' },
    scout: { sizeBucket: 'small', lenses: ['naming'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
    gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
    lens: ({ callIndex }) => ({ lens: 'naming', findings: callIndex === 0 ? CRITICALS.concat(MEDIUMS) : [] }),
    dedup: { groups: [] },
    verify: individualVote,
    'verify-batch': ({ prompt }) => ({
      verdicts: [...prompt.matchAll(/--- FINDING (\d+) ---/g)].map(m => ({ index: Number(m[1]), ...CONFIRMS })),
    }),
    // Synthesis dies on purpose: the mechanical fallback report is the ENGINE's own rendering, which
    // is what the visibility assertion below has to be made against.
    synthesis: null,
    '*': null,
  }
}

const batchDispatches = calls => calls.filter(c => /verify-batch/.test(String(c.label))).length

test('review: a Medium buys no verifier once a Critical has already come back confirmed', async () => {
  const { calls, logs } = await runEngine('review', { args: {}, script: scriptFor(() => CONFIRMS) })
  assert.equal(
    batchDispatches(calls),
    0,
    `every Medium batch queued behind a confirmed-Critical panel must go unbought — this is ${MEDIUM_GROUPS} agent(s) here and the whole batched population of a real run`,
  )
  assert.ok(
    logs.some(l => /fixed at Block/.test(l) && /Critical/.test(l)),
    'the engine must SAY the floor was raised, naming the evidence — a saving made silently is indistinguishable from a bug',
  )
  assert.ok(
    logs.some(l => /NOT dispatched/.test(l)),
    'and it must say which check it did not dispatch',
  )
})

test('review: with nothing confirmed, every Medium still buys its verifier', async () => {
  // The other half of the order dependency. Same population, same queueing — but the Criticals come
  // back REFUTED, so no verdict is fixed and a Medium can still decide Warning against Approve.
  const { calls } = await runEngine('review', { args: {}, script: scriptFor(() => REFUTES) })
  assert.equal(
    batchDispatches(calls),
    MEDIUM_GROUPS,
    'a skip resting on an expected Block rather than a confirmed one would silence findings that still decide the verdict',
  )
})

test('review: a Medium nobody verified is reported as unverified, out of the denominator, in notRun, and VISIBLE', async () => {
  const { calls, report } = await runEngine('review', { args: {}, script: scriptFor(() => CONFIRMS) })
  const rec = filedRecord({ calls })
  assert.ok(rec, 'the run record must have been filed')

  // 1. The tier. Same route as every death — no second route was invented for this skip.
  assert.equal(rec.verification.unverified, MEDIUMS.length, 'every skipped Medium carries the unverified tier')

  // 2. Out of the denominator. `candidates` is defined as what verification actually judged, so a
  // refutation rate stays comparable between runs.
  assert.equal(
    rec.verification.candidates,
    CRITICALS.length,
    'the denominator must be the individual panel alone — including what was never checked makes one run\'s refutation rate incomparable with another\'s',
  )

  // 3. In notRun, saying it was deliberate rather than dead — the two need a re-run for opposite
  // reasons, and notRun is ranked by exact string.
  assert.ok(
    rec.notRun.some(n => /deliberately not dispatched/.test(n) && /already fixed at Block/.test(n)),
    `notRun must carry the skip and name it as one: ${JSON.stringify(rec.notRun)}`,
  )
  assert.ok(
    !rec.notRun.some(n => /died before returning a verdict/.test(n)),
    'and must NOT describe a deliberate saving as a death',
  )

  // 4. VISIBLE. "We did not check this because the verdict is Block anyway" is legitimate; "the
  // finding vanished" is not. Every skipped Medium must still be named in the report.
  for (const m of MEDIUMS) {
    assert.ok(report.includes(m.title), `${m.title} disappeared from the report`)
  }
  assert.match(report, /NOT VERIFIED/, 'and the report must say they were not verified')
})
