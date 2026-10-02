import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { aggregate, renderReport, renderEngineSection, loadRecords, partitionByCompleteness } from './analyze-runs.mjs'

/** A lookup the test goes on to assert on: fails loudly if it found nothing, and narrows away undefined/null.
 * @template T
 * @param {T | undefined | null} x
 * @returns {T} */
const defined = x => {
  assert.ok(x != null)
  return x
}

const REVIEW_1 = {
  schemaVersion: 1, name: 'review', verdict: 'Warning',
  verification: { candidates: 5, confirmed: 2, refuteRate: 0.6 }, outputTokens: 1000,
  notRun: ['rust lens safety'],
  dimensions: [
    { dimension: 'rust:safety', findingCount: 1, bySeverity: { Critical: 0, High: 0, Medium: 1, Low: 0, Info: 0 } },
    { dimension: 'rust:errors', findingCount: 0, bySeverity: { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 } },
  ],
}
const REVIEW_2 = {
  schemaVersion: 1, name: 'review', verdict: 'Approve (INCOMPLETE)',
  verification: { candidates: 0, confirmed: 0, refuteRate: 0 }, outputTokens: 500,
  notRun: ['rust lens safety', 'rust completeness-critic'],
  dimensions: [{ dimension: 'rust:safety', findingCount: 0, bySeverity: {} }],
}
const AUDIT = {
  schemaVersion: 1, name: 'rust-audit', verdict: 'Block',
  verification: { candidates: 3, confirmed: 1, refuteRate: 0.67 }, outputTokens: 2000, notRun: [],
  dimensions: [{ dimension: 'security', findingCount: 2, bySeverity: { Critical: 1, High: 1, Medium: 0, Low: 0, Info: 0 } }],
}

test('aggregate on empty input is all-zero', () => {
  assert.deepEqual(aggregate([]), {
    totalRuns: 0, incompleteRuns: 0, uncoveredRuns: 0, workflows: [], notRun: [],
    savedByFloor: [], savedByFloorRevokedRuns: 0, uncoveredFiles: [],
    dimensions: [], engines: [], unattributedRuns: 0, versionCollisions: [], separable: true,
  })
})

test('aggregate ignores non-object records', () => {
  assert.equal(aggregate([null, 42, 'x', undefined]).totalRuns, 0)
})

test('aggregate tallies runs, verdicts and INCOMPLETE', () => {
  const a = aggregate([REVIEW_1, REVIEW_2, AUDIT])
  assert.equal(a.totalRuns, 3)
  assert.equal(a.incompleteRuns, 1)
  // sorted by run count desc → review (2) before rust-audit (1)
  assert.deepEqual(a.workflows.map(w => w.name), ['review', 'rust-audit'])
  const review = defined(a.workflows.find(w => w.name === 'review'))
  // `Approve (INCOMPLETE)` counts as incomplete ONLY — an incomplete run is not an approve, and
  // counting it in both columns inflated the approve figure into a coverage claim.
  assert.deepEqual(review.verdicts, { block: 0, warning: 1, approve: 0, incomplete: 1 })
  assert.equal(review.avgRefuteRate, 0.3)        // (0.6 + 0) / 2
  // Neither record carries `round`, so neither is first-pass OR re-review — both land in the
  // Unclassified pool. Reading a round-less run as first-pass is the very defect the split guards.
  assert.equal(review.avgRunTokenPoolFirstPass, null)
  assert.equal(review.avgRunTokenPoolReReview, null)
  assert.equal(review.avgRunTokenPoolUnclassified, 750)   // (1000 + 500) / 2
  const audit = defined(a.workflows.find(w => w.name === 'rust-audit'))
  assert.equal(audit.verdicts.block, 1)
  assert.equal(audit.avgRefuteRate, 0.67)
})

// `outputTokens` is NOT output tokens — it is budget.spent(), the whole-run token POOL (input +
// output + parent-driver + cache). Its size is set by run TYPE: a re-review (round > 1) runs an
// extra Adjudicate phase and a whole-diff re-scan, so its pool is structurally MUCH larger than a
// first-pass's (round 1). Blending them into one average is the same anti-pattern the file already
// guards for refuteTracked/legacy and thinned/thinnedMeasured — what cannot be told apart is not
// quietly averaged as one number. So the pool is split by run type and reported as two metrics,
// each named as a POOL, never "output".
test('run-token pool is split by run type (first-pass vs re-review), never blended into one average', () => {
  /** @param {number} round @param {number} outputTokens */
  const mk = (round, outputTokens) => ({ schemaVersion: 1, name: 'review', verdict: 'Warning', notRun: [], dimensions: [], round, outputTokens })
  // Two first-pass runs (round 1) at a small pool; one re-review (round 2) at a structurally larger one.
  const a = aggregate([mk(1, 1000), mk(1, 2000), mk(2, 9000)])
  const review = defined(a.workflows.find(w => w.name === 'review'))
  assert.equal(review.avgRunTokenPoolFirstPass, 1500, 'first-pass pool averages only the round-1 runs')
  assert.equal(review.avgRunTokenPoolReReview, 9000, 'the re-review pool is reported apart, not folded in')
  // The blended figure the old code produced would be (1000+2000+9000)/3 = 4000 — a number that is
  // neither pool and calls a re-review-inflated total "output". It must not exist as a single field.
  assert.equal(/** @type {Record<string, unknown>} */ (review)['avgOutputTokens'], undefined, 'the blended, mislabelled "output" average is gone')
  const out = renderReport(a)
  assert.match(out, /first-pass/, 'the report exposes the first-pass pool')
  assert.match(out, /re-review/, 'and the re-review pool apart from it')
  assert.ok(!/out-tok/.test(out), 'and no longer labels the pool "output"')
})

// The pool split is THREE-STATE, keyed on the PRESENCE and value of `round`, never two. Only
// `review` stamps `round`; `adversarial-review`, `rust-audit` and `triage-findings` write
// `outputTokens` with no `round` at all. Reading an absent `round` as first-pass is the same "NOT
// MEASURED IS NOT ZERO" defect the thinned clause guards against: it labels those runs `(first-pass)`
// and so implies a `(re-review)` counterpart that can never exist for these engines. A round-less
// bucket is its own thing — a single plain pool, no run-type label.
test('a workflow that never stamps round reports a single plain pool — no phantom first-pass/re-review split', () => {
  /** @param {number} outputTokens */
  const mk = outputTokens => ({ schemaVersion: 1, name: 'rust-audit', verdict: 'Approve', notRun: [], dimensions: [], outputTokens })
  const a = aggregate([mk(3000), mk(5000)])
  const audit = defined(a.workflows.find(w => w.name === 'rust-audit'))
  assert.equal(audit.avgRunTokenPoolFirstPass, null, 'round-less runs are NOT first-pass')
  assert.equal(audit.avgRunTokenPoolReReview, null, 'and there is no re-review pool to invent')
  assert.equal(audit.avgRunTokenPoolUnclassified, 4000, 'they form one unclassified pool')
  const line = defined(renderReport(a).split('\n').find(l => l.startsWith('- rust-audit:')))
  assert.match(line, /~4000 tok-pool\/run \(round not recorded\)/, 'rendered as one round-less pool, neutrally labelled')
  assert.ok(!/first-pass/.test(line), 'never labelled (first-pass)')
  assert.ok(!/re-review/.test(line), 'and no phantom (re-review) counterpart')
})

// FINDING 1's window: `review` gained `round` (2026-07-20) later than `outputTokens` (2026-07-08),
// so a band of re-reviews carries a structurally larger pool with NO round. Folding those into
// first-pass inflates it silently — the refuteTracked/legacy discipline says count the round-less
// ones APART and print a caveat, exactly as `refute basis LEGACY` does when the discriminator is
// absent.
test('a review workflow mixing round>1, round==1 and round-absent splits the pools and counts the round-less runs apart', () => {
  /** @param {number} round @param {number} outputTokens */
  const mk = (round, outputTokens) => ({ schemaVersion: 1, name: 'review', verdict: 'Warning', notRun: [], dimensions: [], round, outputTokens })
  /** @param {number} outputTokens */
  const noRound = outputTokens => ({ schemaVersion: 1, name: 'review', verdict: 'Warning', notRun: [], dimensions: [], outputTokens })
  const a = aggregate([mk(1, 1000), mk(1, 2000), mk(2, 9000), noRound(8000)])
  const review = defined(a.workflows.find(w => w.name === 'review'))
  assert.equal(review.avgRunTokenPoolFirstPass, 1500, 'first-pass averages only the round==1 runs, not the round-less one')
  assert.equal(review.avgRunTokenPoolReReview, 9000, 'the re-review pool is the round>1 run')
  assert.equal(review.avgRunTokenPoolUnclassified, 8000, 'the round-less re-review is held apart, never folded into first-pass')
  assert.equal(review.poolUnclassifiedN, 1, 'and its sample size is carried so the caveat can name it')
  const line = defined(renderReport(a).split('\n').find(l => l.startsWith('- review:')))
  assert.match(line, /~1500 tok-pool\/run \(first-pass\)/)
  assert.match(line, /~9000 tok-pool\/run \(re-review\)/)
  assert.match(line, /~8000 tok-pool\/run \(round not recorded\)/, 'the round-less run surfaces as its own neutrally-labelled pool, apart from the split')
})

// F4: an all-round-less `review` bucket (both round-bearing pools null, only the Unclassified pool
// populated) must STILL surface its pool with the neutral `(round not recorded)` label — never a
// bare figure that silently drops the round-less signal. REVIEW_1/REVIEW_2 build exactly this shape:
// two round-less `review` runs. The old render gated the label behind a round-bearing pool and fell
// through to a bare figure here, so an all-round-less review bucket read identically to a
// never-stamps engine's.
test('an all-round-less review bucket renders its pool labelled (round not recorded), not bare', () => {
  const line = defined(renderReport(aggregate([REVIEW_1, REVIEW_2])).split('\n').find(l => l.startsWith('- review:')))
  assert.match(line, /~750 tok-pool\/run \(round not recorded\)/, 'the round-less pool is labelled, not a bare figure')
  assert.ok(!/first-pass/.test(line), 'no phantom (first-pass) label')
  assert.ok(!/re-review/.test(line), 'and no phantom (re-review) label')
})

// F2: the rendered pool clause must never assert a CAUSE for a round-less run. It is false that a
// round-less `review` run "predates the `round` field" — `review` has current early-exit paths that
// stamp `outputTokens` with no `round`, so a round-less run is often a current early-exit, not a
// historical record. The label names the observable property (no round recorded), never a cause.
test('the rendered pool clause never asserts a cause for a round-less run', () => {
  /** @param {number} round @param {number} outputTokens */
  const mk = (round, outputTokens) => ({ schemaVersion: 1, name: 'review', verdict: 'Warning', notRun: [], dimensions: [], round, outputTokens })
  /** @param {number} outputTokens */
  const noRound = outputTokens => ({ schemaVersion: 1, name: 'review', verdict: 'Warning', notRun: [], dimensions: [], outputTokens })
  const out = renderReport(aggregate([mk(1, 1000), mk(2, 9000), noRound(8000)]))
  assert.ok(!/predate/.test(out), 'no rendered clause claims a round-less run "predates" anything')
})

test('a clean Approve still lands in the approve bucket, and only there', () => {
  const a = aggregate([{ schemaVersion: 1, name: 'review', verdict: 'Approve', notRun: [], dimensions: [] }])
  const review = defined(a.workflows.find(w => w.name === 'review'))
  assert.deepEqual(review.verdicts, { block: 0, warning: 0, approve: 1, incomplete: 0 })
  assert.equal(a.incompleteRuns, 0)
})

test('Approve (PARTIAL COVERAGE) buckets as incomplete, never as a clean approve', () => {
  // review.js now spells a coverage hole ' (PARTIAL COVERAGE)', distinct from a re-runnable
  // ' (INCOMPLETE)'. A coverage hole voids the approve exactly as INCOMPLETE does — the claim
  // "nothing was found" holds only over what was looked at. Under the OLD `/INCOMPLETE/i`-only regex
  // this verdict matched nothing and fell into the clean-approve bucket (approve:1, incomplete:0);
  // that is the reversal this asserts against.
  const a = aggregate([{ schemaVersion: 1, name: 'review', verdict: 'Approve (PARTIAL COVERAGE)', notRun: [], dimensions: [] }])
  const review = defined(a.workflows.find(w => w.name === 'review'))
  assert.deepEqual(review.verdicts, { block: 0, warning: 0, approve: 0, incomplete: 1 })
  assert.equal(review.partialCoverage, 1)
  assert.equal(a.incompleteRuns, 1)
})

test('Block (PARTIAL COVERAGE) stays in the block bucket, counted apart as partial coverage', () => {
  // SEVERITY FIRST: a block is a finding that was actually made; a coverage hole cannot un-find it.
  const a = aggregate([{ schemaVersion: 1, name: 'review', verdict: 'Block (PARTIAL COVERAGE)', notRun: [], dimensions: [] }])
  const review = defined(a.workflows.find(w => w.name === 'review'))
  assert.deepEqual(review.verdicts, { block: 1, warning: 0, approve: 0, incomplete: 0 })
  assert.equal(review.partialCoverage, 1)
  assert.equal(a.incompleteRuns, 1)
})

test('aggregate ranks NOT-RUN frequency (fragility) highest first', () => {
  const a = aggregate([REVIEW_1, REVIEW_2, AUDIT])
  assert.deepEqual(a.notRun, [
    { item: 'rust lens safety', count: 2 },
    { item: 'rust completeness-critic', count: 1 },
  ])
})

test('aggregate sums per-dimension confirmed findings, sorted by volume', () => {
  const a = aggregate([REVIEW_1, REVIEW_2, AUDIT])
  assert.deepEqual(a.dimensions.map(d => d.dimension), ['security', 'rust:safety', 'rust:errors'])
  const safety = defined(a.dimensions.find(d => d.dimension === 'rust:safety'))
  assert.equal(safety.runs, 2)              // appeared in REVIEW_1 and REVIEW_2
  assert.equal(safety.findings, 1)
  assert.equal(safety.findingsPerRun, 0.5)
  const security = defined(a.dimensions.find(d => d.dimension === 'security'))
  assert.equal(security.bySeverity.Critical, 1)
  assert.equal(security.bySeverity.High, 1)
})

test('renderReport produces a string with the expected sections', () => {
  const out = renderReport(aggregate([REVIEW_1, REVIEW_2, AUDIT]))
  assert.match(out, /## Workflows/)
  assert.match(out, /## NOT RUN/)
  assert.match(out, /## Dimensions/)
  assert.match(out, /## NOISE/)
  assert.match(out, /rust lens safety/)
})

// Per-lens telemetry (confirmedCount/suspectedCount/refutedCount) — present on runs recorded
// after that telemetry landed. api-idioms over-refutes (6 of 8 candidates); safety does not.
const REVIEW_TELEMETRY = {
  schemaVersion: 1, name: 'review', verdict: 'Warning',
  verification: { candidates: 10, confirmed: 3, refuteRate: 0.7 }, outputTokens: 800, notRun: [],
  dimensions: [
    { dimension: 'rust:api-idioms', findingCount: 1, bySeverity: { Critical: 0, High: 0, Medium: 0, Low: 1, Info: 0 }, confirmedCount: 1, suspectedCount: 1, refutedCount: 6 },
    { dimension: 'rust:safety', findingCount: 2, bySeverity: { Critical: 0, High: 0, Medium: 2, Low: 0, Info: 0 }, confirmedCount: 2, suspectedCount: 0, refutedCount: 0 },
  ],
}

test('aggregate computes per-lens refute rate from confirmed/suspected/refuted counts', () => {
  const a = aggregate([REVIEW_TELEMETRY])
  const api = defined(a.dimensions.find(d => d.dimension === 'rust:api-idioms'))
  assert.equal(api.candidates, 8)          // 1 + 1 + 6
  assert.equal(api.refuted, 6)
  assert.equal(api.refuteRate, 0.75)       // 6 / 8
  const safety = defined(a.dimensions.find(d => d.dimension === 'rust:safety'))
  assert.equal(safety.refuteRate, 0)       // 0 / 2
})

test('dimensions without per-lens counts get refuteRate null (old-schema records)', () => {
  const safety = defined(aggregate([REVIEW_1]).dimensions.find(d => d.dimension === 'rust:safety'))
  assert.equal(safety.candidates, 0)
  assert.equal(safety.refuteRate, null)    // null, not 0 — no per-lens data to judge
})

// The NOISE section ranks OVER-refuting lenses. Without a rate floor it listed every lens with
// enough candidates — a lens at refute 0.00 got the header "over-refuting" and the advice "tighten
// this lens's rubric", which for a perfectly precise lens means suppressing findings that were all
// being confirmed. Seen on a real 60-run store: 13 of 13 ranked lenses listed, bottom two at 0/9
// and 0/5.
test('NOISE lists only lenses that actually over-refute — a precise lens is never told to tighten', () => {
  const out = renderReport(aggregate([REVIEW_TELEMETRY]))
  const noise = out.slice(out.indexOf('## NOISE'))
  assert.match(noise, /rust:api-idioms/, 'the 0.75-refute lens is ranked')
  assert.ok(!noise.includes('rust:safety'), 'the 0.00-refute lens is NOT told to tighten its rubric')
})

test('NOISE says so explicitly when every rated lens is below the floor — not an empty-looking section', () => {
  const clean = {
    ...REVIEW_TELEMETRY,
    dimensions: [{ dimension: 'rust:safety', findingCount: 5, bySeverity: { Critical: 0, High: 0, Medium: 5, Low: 0, Info: 0 }, confirmedCount: 5, suspectedCount: 0, refutedCount: 0 }],
  }
  const noise = renderReport(aggregate([clean])).slice(renderReport(aggregate([clean])).indexOf('## NOISE'))
  assert.match(noise, /none — all 1 lens/, 'reports "none", distinct from "no telemetry yet"')
  assert.ok(!noise.includes('no per-lens refute data yet'), 'not confused with the absent-telemetry case')
})

// A dimension row is emitted for every PLANNED lens, so a lens that never returned renders as a
// 0-finding row — identical to one that ran and found nothing. That is the difference between
// "redundant, drop it" and "broken, fix it", and yield-per-run divides by the dead runs too.
test('a lens that never returned is excluded from its own yield denominator and flagged', () => {
  /** @param {boolean} ran */
  const mk = ran => ({
    schemaVersion: 1, name: 'review', verdict: 'Warning', outputTokens: 100, notRun: [],
    dimensions: [{ dimension: 'rust:ownership', ran, findingCount: ran ? 4 : 0, bySeverity: { Critical: 0, High: 0, Medium: 0, Low: ran ? 4 : 0, Info: 0 } }],
  })
  // One run where it worked and found 4; two where it never returned.
  const own = defined(aggregate([mk(true), mk(false), mk(false)]).dimensions.find(d => d.dimension === 'rust:ownership'))
  assert.equal(own.runs, 1, 'dead runs are not counted as runs')
  assert.equal(own.dead, 2)
  assert.equal(own.findingsPerRun, 4, 'yield is 4/run, not 1.33/run — the dead runs do not dilute it')
  assert.match(renderReport(aggregate([mk(true), mk(false)])), /2 run\(s\) it never returned|1 run\(s\) it never returned/)
})

test('records predating the ran flag count as having run — no retroactive guessing', () => {
  const legacy = {
    schemaVersion: 1, name: 'review', verdict: 'Warning', outputTokens: 100, notRun: [],
    dimensions: [{ dimension: 'rust:safety', findingCount: 2, bySeverity: { Critical: 0, High: 0, Medium: 2, Low: 0, Info: 0 } }],
  }
  const d = defined(aggregate([legacy]).dimensions.find(x => x.dimension === 'rust:safety'))
  assert.equal(d.runs, 1, 'missing ran flag → counted, as before')
  assert.equal(d.dead, 0)
})

test('loadRecords separates unreadable files from records — lost telemetry is never a silent gap', () => {
  // A 0-byte record (a write that died mid-flight) was found in a real store; the only trace was
  // the run count not matching the file listing. It must be reported, not swallowed.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-runs-'))
  fs.writeFileSync(path.join(dir, 'a-workflow-review.json'), JSON.stringify(REVIEW_TELEMETRY))
  fs.writeFileSync(path.join(dir, 'b-workflow-review.json'), '')          // truncated write
  fs.writeFileSync(path.join(dir, 'index.jsonl'), '{"ignored":true}\n')   // not a record
  const { records, unreadable } = defined(loadRecords(dir))
  assert.equal(records.length, 1, 'only the parseable record is loaded')
  assert.equal(unreadable.length, 1, 'the truncated one is reported, not dropped')
  assert.equal(defined(unreadable[0]).file, 'b-workflow-review.json')
  assert.ok(defined(unreadable[0]).reason, 'carries the parse error')
  assert.equal(loadRecords(path.join(dir, 'nope')), null, 'missing store still returns null')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('NOISE section ranks over-refuting lenses above the candidate floor', () => {
  const out = renderReport(aggregate([REVIEW_TELEMETRY]))
  assert.match(out, /## NOISE/)
  assert.match(out, /rust:api-idioms: refute 0\.75 \(6\/8\)/)   // 8 candidates ≥ floor → listed
  assert.doesNotMatch(out, /rust:safety: refute/)               // only 2 candidates < floor → omitted
})

// A recovered run is a record of an OUTAGE. Its lenses never all reported and its verification never
// finished, so letting it into the aggregate would blame the rubric for a usage limit.
test('partitionByCompleteness keeps dead runs out of every averaged rate', () => {
  const done = { schemaVersion: 1, name: 'review', verdict: 'Block' }
  const dead = { schemaVersion: 1, name: 'review', verdict: 'INCOMPLETE', partial: true }
  const { complete, partial } = partitionByCompleteness([done, dead, done])
  assert.equal(complete.length, 2)
  assert.equal(partial.length, 1)
  assert.equal(complete.some(r => r.partial), false)
  // Malformed entries are dropped by both buckets rather than crashing the report.
  assert.deepEqual(partitionByCompleteness([null, undefined]), { complete: [], partial: [] })
  assert.deepEqual(partitionByCompleteness(null), { complete: [], partial: [] })
})

test('verdict buckets are mutually exclusive — they sum to the run count', () => {
  /** @param {string} verdict */
  const mk = verdict => ({ schemaVersion: 1, name: 'review', verdict, notRun: [], dimensions: [] })
  const records = [
    mk('Block (INCOMPLETE)'), mk('Warning (INCOMPLETE)'), mk('Approve (INCOMPLETE)'),
    mk('INCOMPLETE'), mk('Block'), mk('Warning'), mk('Approve'), mk('Healthy'), mk('At-risk'),
  ]
  const a = aggregate(records)
  const w = defined(a.workflows.find(x => x.name === 'review'))
  const { block, warning, approve, incomplete } = w.verdicts
  // The load-bearing assertion: no run may be counted in two buckets.
  assert.equal(block + warning + approve + incomplete, w.runs)
  assert.equal(w.runs, records.length)
  // Severity first, then coverage: a suffixed Block/Warning stays a block/warning; a suffixed
  // Approve becomes incomplete, never an approve.
  assert.deepEqual(w.verdicts, { block: 3, warning: 2, approve: 2, incomplete: 2 })
  // ...while the top-level total of INCOMPLETE runs stays honest and may overlap those buckets.
  assert.equal(a.incompleteRuns, 4)
  assert.equal(w.partialCoverage, 4, 'the per-workflow overlap total must be carried too')
})

test('the report never spells two different quantities with the same word', () => {
  // `incompleteRuns` (overlapping: any INCOMPLETE-suffixed run) and `verdicts.incomplete` (the
  // exclusive bucket) are different numbers. Ten `Block (INCOMPLETE)` runs used to render as
  // "10 run(s), 10 incomplete" in the header while the row read `B/W/A 10/0/0` with no incomplete
  // clause at all — the same word naming two quantities, one of them invisible.
  /** @param {string} verdict */
  const mk = verdict => ({ schemaVersion: 1, name: 'review', verdict, notRun: [], dimensions: [] })
  const a = aggregate(Array.from({ length: 10 }, () => mk('Block (INCOMPLETE)')))
  const out = renderReport(a)
  const header = defined(out.split('\n')[0])
  const row = defined(out.split('\n').find(l => l.startsWith('- review:')))
  assert.match(header, /10 run\(s\), 10 with partial coverage/)
  assert.ok(!/10 incomplete$/.test(header), 'the header must not call the overlap total "incomplete"')
  assert.match(row, /B\/W\/A 10\/0\/0/)
  assert.match(row, /10 partial coverage/, 'the row must surface the overlap the header counts')
  assert.ok(!/incomplete-only/.test(row), 'the exclusive bucket is empty here and must not be printed')

  // And the exclusive bucket keeps its own distinct label.
  const b = aggregate([mk('INCOMPLETE'), mk('Approve (INCOMPLETE)')])
  const brow = defined(renderReport(b).split('\n').find(l => l.startsWith('- review:')))
  assert.match(brow, /2 incomplete-only/)
  assert.match(brow, /2 partial coverage/)
})

// ---- uncovered files are ranked as FILES, not folded into notRun ----
//
// The defect: uncovered files used to be folded into `notRun` as one note embedding a count and
// up to five file names. `notRun` is ranked by EXACT STRING to surface repeated fragility, so
// every run contributed a unique key — the ranking filled with count-1 rows and the genuinely
// repeated failures sank. It was also the opposite claim: a notRun entry is fixable by re-running,
// an uncovered file never will be.

const run = (extra = {}) => ({ name: 'review', verdict: 'Approve', ...extra })

test('uncovered files are ranked as files, and never pollute the notRun ranking', () => {
  const a = aggregate([
    run({ uncoveredFiles: ['a.py', 'b.sh'], notRun: ['rust lenses that never returned — timeout'] }),
    run({ uncoveredFiles: ['a.py'], notRun: ['rust lenses that never returned — timeout'] }),
    run({ uncoveredFiles: ['c.sql'] }),
  ])
  assert.deepEqual(a.notRun, [{ item: 'rust lenses that never returned — timeout', count: 2 }],
    'the repeated failure must be the only notRun key, ranked by its real count')
  assert.equal(a.uncoveredRuns, 3)
  assert.deepEqual(a.uncoveredFiles, [
    { file: 'a.py', count: 2 }, { file: 'b.sh', count: 1 }, { file: 'c.sql', count: 1 },
  ])
})

test('a file listed twice in one run counts once for that run', () => {
  const a = aggregate([run({ uncoveredFiles: ['a.py', 'a.py'] })])
  assert.deepEqual(a.uncoveredFiles, [{ file: 'a.py', count: 1 }])
})

test('records without uncoveredFiles are tolerated', () => {
  const a = aggregate([run(), run({ uncoveredFiles: 'nonsense' }), null, 7])
  assert.equal(a.uncoveredRuns, 0)
  assert.deepEqual(a.uncoveredFiles, [])
})

test('the rendered report has its own NOT REVIEWED section', () => {
  const out = renderReport(aggregate([run({ uncoveredFiles: ['a.py'] })]))
  assert.match(out, /## NOT REVIEWED — files no language profile covered \(1 run\(s\)\)/)
  assert.match(out, /- 1× a\.py/)
  assert.match(out, /## NOT RUN — fragility/)
})

// ---- the engine boundary ---------------------------------------------------------------------
const engineRun = (over = {}) => ({ schemaVersion: 1, runtime: 'claude-code', name: 'review', verdict: 'Approve', ...over })

test('two engines under ONE version string are counted apart, and the aggregate admits it', () => {
  // The defect exactly: rigor moved to a fixed table inside the 0.16.0 window, so a version filter
  // would hand both engines back as one population.
  const a = aggregate([
    engineRun({ craftVersion: '0.16.0' }),
    engineRun({ craftVersion: '0.16.0', engineRevision: 2 }),
  ])
  assert.equal(a.engines.length, 2)
  assert.deepEqual(a.engines.map(e => e.engine).sort(),
    ['claude-code 0.16.0 r2', 'claude-code 0.16.0 r?'])
  assert.equal(a.unattributedRuns, 1)
  assert.equal(a.separable, false, 'a mixed population must never claim to be one engine')
})

test('an aggregate of one fully attributed engine says it compares like with like', () => {
  const a = aggregate([engineRun({ craftVersion: '0.16.0', engineRevision: 2 }), engineRun({ craftVersion: '0.16.0', engineRevision: 2 })])
  assert.equal(a.separable, true)
  assert.equal(a.unattributedRuns, 0)
  assert.deepEqual(a.engines, [{ engine: 'claude-code 0.16.0 r2', runs: 2 }])
  assert.match(renderReport(a), /_Engine: claude-code 0\.16\.0 r2 — all 2 run\(s\)\. Rates below compare like with like\._/)
})

test('records that all lack a revision are NOT declared one engine', () => {
  // One version can span a behaviour change, so "they all say 0.16.0" is not evidence of sameness.
  // Same stance as worstVerdict on an unrecognised verdict: absence never resolves to the
  // convenient answer.
  const a = aggregate([engineRun({ craftVersion: '0.16.0' }), engineRun({ craftVersion: '0.16.0' })])
  assert.equal(a.engines.length, 1)
  assert.equal(a.separable, false)
  assert.equal(a.unattributedRuns, 2)
})

test('the report states the boundary BEFORE any rate, and never silently aggregates', () => {
  const out = renderReport(aggregate([
    engineRun({ craftVersion: '0.16.0', dimensions: [{ dimension: 'rust:safety', findingCount: 3, bySeverity: {} }] }),
    engineRun({ craftVersion: '0.16.0', engineRevision: 2 }),
  ]))
  assert.match(out, /## ⚠️ ENGINE BOUNDARY — this aggregate spans 2 engine build\(s\)/)
  assert.match(out, /It is NOT a before\/after measurement/)
  assert.match(out, /1× claude-code 0\.16\.0 r\?/)
  assert.match(out, /carry NO engineRevision/)
  assert.ok(out.indexOf('ENGINE BOUNDARY') < out.indexOf('## Workflows'),
    'a caveat printed under the numbers arrives after the reader has already been misled')
})

test('an opencode record is a different engine, not an unversioned claude-code one', () => {
  const a = aggregate([engineRun({ craftVersion: '0.16.0', engineRevision: 2 }), engineRun({ runtime: 'opencode' })])
  assert.deepEqual(a.engines.map(e => e.engine).sort(), ['claude-code 0.16.0 r2', 'opencode unversioned r?'])
  assert.equal(a.separable, false)
})

test('an empty aggregate does not claim to be one comparable engine — and does not cry boundary', () => {
  const a = aggregate([])
  assert.deepEqual(a.engines, [])
  assert.equal(a.separable, true)
  const out = renderReport(a)
  // It used to render "spans 0 engine build(s)" whose rates were averaged "ACROSS them".
  assert.doesNotMatch(out, /ENGINE BOUNDARY/)
  assert.doesNotMatch(out, /compare like with like/)
  assert.match(out, /_No runs to attribute to an engine\._/)
})

test('a store of ONE unattributed bucket is a note, not a cross-engine boundary', () => {
  // Every OpenCode store and every pre-change store is exactly this shape. The banner fired on it
  // and announced that the aggregate "spans 1 engine build(s)" averaged "ACROSS them" — incoherent,
  // and a false alarm teaches the reader to skip the section that matters.
  const a = aggregate([engineRun({ runtime: 'opencode' }), engineRun({ runtime: 'opencode' })])
  assert.equal(a.engines.length, 1)
  assert.equal(a.unattributedRuns, 2)
  const out = renderReport(a)
  assert.doesNotMatch(out, /ENGINE BOUNDARY/)
  assert.doesNotMatch(out, /averaged ACROSS/)
  assert.match(out, /_Engine: opencode unversioned r\? — all 2 run\(s\), none of which carries an engineRevision\._/)
  // ...but it must NOT claim like-with-like either: one bucket is not proof of one build.
  assert.doesNotMatch(out, /compare like with like/)
})

test('unattributed records are filterable — the report must not claim otherwise', () => {
  // engineKey is deterministic, so `--engine "opencode unversioned r?"` selects exactly them. The
  // old text said "no filter can separate them", which is simply false.
  const a = aggregate([engineRun({ craftVersion: '0.16.0', engineRevision: 2 }), engineRun({ runtime: 'opencode' })])
  const out = renderReport(a)
  assert.match(out, /## ⚠️ ENGINE BOUNDARY — this aggregate spans 2 engine build\(s\)/)
  assert.doesNotMatch(out, /no filter can separate them/)
  assert.match(out, /`--engine "<runtime> <version> r\?"` selects/)
  assert.match(out, /not known to be a single engine build/)
})

// ---- the unverified tier is read, and the denominator's change of meaning is said out loud -----
// `workflows/review.js` writes `unverifiedCount` into every lens row: candidates no verifier ever
// judged (an unchecked Low/Info the engine deliberately spends no verifier on). Nothing read it —
// and worse, the dimension-level refute denominator silently changed meaning when the tier landed.
// Before it, those same unjudged items were filed under `suspectedCount` and so sat INSIDE the
// denominator; after it they sit outside. Same field name, same `schemaVersion: 1`, two different
// rates. The records cannot be relabelled, so the report has to say which it is looking at.
const UNVERIFIED_TIER = {
  schemaVersion: 1, name: 'review', verdict: 'Warning',
  // `unverified` on the RUN-level `verification` too, not only on the lens row: a record written
  // after the tier carries it at both levels, and the run-level denominator changed meaning in
  // exactly the same way. A fixture carrying it at one level only is a post-tier record pretending
  // to be pre-tier at the other, which is what made this a `strict` dimension inside a `legacy` run.
  verification: { candidates: 4, confirmed: 2, refuteRate: 0.25, unverified: 5 }, outputTokens: 100, notRun: [],
  dimensions: [
    { dimension: 'rust:safety', findingCount: 2, bySeverity: { Critical: 0, High: 0, Medium: 2, Low: 0, Info: 0 }, confirmedCount: 2, suspectedCount: 1, refutedCount: 1, unverifiedCount: 5 },
  ],
}

test('aggregate surfaces unverifiedCount and keeps it out of the refute denominator', () => {
  const d = defined(aggregate([UNVERIFIED_TIER]).dimensions.find(x => x.dimension === 'rust:safety'))
  assert.equal(d.unverified, 5, 'the tier is reported, not dropped on the floor')
  assert.equal(d.candidates, 4, 'and it is NOT in the denominator — 2 confirmed + 1 suspected + 1 refuted')
  assert.equal(d.refuteRate, 0.25, '1 / 4, not 1 / 9')
  assert.equal(d.refuteBasis, 'strict', 'every contributing row carries the field')
})

test('a dimension row names its refute basis, so a legacy or mixed denominator is not read as like-for-like', () => {
  // A row from BEFORE the tier: no `unverifiedCount` at all, so its unjudged items are inside
  // `suspectedCount` and inside the denominator.
  const legacyRow = {
    ...UNVERIFIED_TIER,
    dimensions: [{ dimension: 'rust:safety', findingCount: 2, bySeverity: { Critical: 0, High: 0, Medium: 2, Low: 0, Info: 0 }, confirmedCount: 2, suspectedCount: 6, refutedCount: 1 }],
  }
  assert.equal(defined(aggregate([legacyRow]).dimensions[0]).refuteBasis, 'legacy')
  assert.equal(defined(aggregate([UNVERIFIED_TIER, legacyRow]).dimensions[0]).refuteBasis, 'mixed',
    'one store holding both sides of the change is not comparable with itself')

  // And it reaches a reader, which is the whole point: an aggregate field nobody renders is the
  // same defect as the field that started this.
  const mixed = renderReport(aggregate([UNVERIFIED_TIER, legacyRow]))
  assert.match(mixed, /refute basis MIXED/)
  assert.match(mixed, /unverified \(outside the rate\)/)
  const legacy = renderReport(aggregate([legacyRow]))
  assert.match(legacy, /refute basis LEGACY/)
  const strict = renderReport(aggregate([UNVERIFIED_TIER]))
  assert.ok(!/refute basis/.test(strict), 'a caveat printed on every row is a caveat nobody reads')
})

// ---- the basis caveat must reach every place the rate is printed, and must not be claimed over
// ---- zero rows ---------------------------------------------------------------------------------

test('a dimension whose every lens row DIED claims no basis at all', () => {
  // `ran: false` rows `continue` before `tracked`/`legacy` are touched, so both are 0 — and
  // `tracked && legacy ? mixed : tracked ? strict : legacy` falls through to `legacy`. That is a
  // statement about a denominator over ZERO contributing rows: it reads as "unjudged items are
  // inside this rate" when no rate exists and nothing was measured.
  const allDead = {
    schemaVersion: 1, name: 'review', verdict: 'Warning', verification: null, outputTokens: 10, notRun: [],
    dimensions: [{ dimension: 'rust:safety', ran: false }],
  }
  const d = defined(aggregate([allDead]).dimensions[0])
  assert.equal(d.dead, 1)
  assert.equal(d.runs, 0, 'nothing ran')
  assert.equal(d.refuteBasis, null, 'so there is no basis to report — not `legacy`, which is a claim')
  const out = renderReport(aggregate([allDead]))
  assert.ok(!/refute basis LEGACY/.test(out), 'and the caveat is not printed over a measurement that does not exist')
})

test('the RUN-level refute denominator names its basis too, and the NOISE section carries the caveat', () => {
  // Two separate gaps, one cause. `verification.candidates` changed meaning in exactly the same way
  // the per-lens denominator did — the engine now excludes unverified candidates from it — but only
  // the dimension row got a `refuteBasis`, so `avg refute` in the Workflows section is two different
  // quantities averaged under one name with nothing saying so. And the NOISE section is the one that
  // PROMPTS AN ACTION ("tighten this lens's rubric"), yet it reprints the rate with no basis clause
  // at all, so the caveat is absent exactly where it would change what a reader does.
  const legacyRun = {
    schemaVersion: 1, name: 'review', verdict: 'Warning',
    // No `unverified` key: a run from before the tier, whose unjudged items are in `candidates`.
    verification: { candidates: 8, confirmed: 2, refuteRate: 0.5 }, outputTokens: 100, notRun: [],
    dimensions: [{ dimension: 'rust:noisy', findingCount: 4, bySeverity: { Critical: 0, High: 0, Medium: 4, Low: 0, Info: 0 }, confirmedCount: 1, suspectedCount: 1, refutedCount: 6 }],
  }
  const a = aggregate([legacyRun])
  assert.equal(defined(a.workflows[0]).refuteBasis, 'legacy', 'the run-level basis is reported, not only the per-lens one')
  const out = renderReport(a)
  assert.match(out, /refute basis LEGACY/, 'the Workflows row says which denominator its average is over')
  // The NOISE row must not print an actionable rate with no basis clause.
  const noise = out.slice(out.indexOf('## NOISE'))
  assert.match(noise, /rust:noisy/, 'the lens is noisy enough to be listed')
  assert.match(noise, /basis/i, 'and the section that tells a reader to tighten a rubric says what the rate is over')
})

test('a run-level basis of `strict` and `mixed` are distinguished, and strict prints no caveat', () => {
  const strictRun = {
    schemaVersion: 1, name: 'review', verdict: 'Warning',
    verification: { candidates: 4, confirmed: 2, refuteRate: 0.25, unverified: 5 }, outputTokens: 100, notRun: [],
    dimensions: [],
  }
  const legacyRun = {
    ...strictRun, verification: { candidates: 8, confirmed: 2, refuteRate: 0.5 },
  }
  assert.equal(defined(aggregate([strictRun]).workflows[0]).refuteBasis, 'strict')
  assert.equal(defined(aggregate([strictRun, legacyRun]).workflows[0]).refuteBasis, 'mixed',
    'one workflow averaging both sides of the change is not comparable with itself')
  assert.ok(!/refute basis/i.test(renderReport(aggregate([strictRun]))),
    'a caveat on every row is a caveat nobody reads')
})

// THINNED PANELS ONLY RANK IF SOMETHING AGGREGATES THEM. The engine records
// `verification.thinned` — verdicts reached after a returned vote was discarded as off-schema —
// precisely because fragility is legible as a REPEAT. That claim held nowhere until this reader
// summed it: neither this aggregate nor the index projection carried the field.
test('aggregate sums thinned panels across runs and names them in the report', () => {
  /** @param {number} thinned @param {string} [verdict] */
  const rec = (thinned, verdict = 'Approve') => ({
    schemaVersion: 1, name: 'review', verdict, notRun: [], dimensions: [],
    verification: { candidates: 4, confirmed: 1, refuteRate: 0.2, unverified: 0, thinned },
  })
  const a = aggregate([rec(2), rec(1), rec(0)])
  const review = defined(a.workflows.find(w => w.name === 'review'))
  assert.equal(review.thinned, 3, 'the verdicts decided on a thinned panel are summed')
  assert.equal(review.thinnedRuns, 2, 'over the runs that had any — a run with none is not one of them')
  assert.match(renderReport(a), /3 verdict\(s\) on a THINNED panel across 2 run\(s\)/, 'and the reader of the report is told')
})

test('aggregate leaves thinned at zero for records that predate the counter', () => {
  const a = aggregate([{ schemaVersion: 1, name: 'review', verdict: 'Approve', notRun: [], dimensions: [], verification: { candidates: 1, confirmed: 1, refuteRate: 0 } }])
  const review = defined(a.workflows.find(w => w.name === 'review'))
  assert.equal(review.thinned, 0)
  assert.equal(review.thinnedRuns, 0)
  assert.ok(!/THINNED panel/.test(renderReport(a)), 'and claims nothing about a field the record does not carry')
})

// NOT MEASURED IS NOT ZERO: only `review` stamps `verification.thinned`, so for any other engine the
// thinning clause is absent for want of a measurement and used to read as a clean panel.
test('the workflow row says thinning was not measured rather than staying silent', () => {
  /** @param {Record<string, unknown>} ver */
  const rec = ver => ({ schemaVersion: 1, name: 'rust-audit', verdict: 'Approve', verification: ver })
  const a = aggregate([rec({ candidates: 2, confirmed: 1 }), rec({ candidates: 2, confirmed: 2 })])
  const w = defined(a.workflows.find(x => x.name === 'rust-audit'))
  assert.equal(w.thinnedMeasured, 0)
  const line = defined(renderReport(a).split('\n').find(l => l.startsWith('- rust-audit:')))
  assert.ok(line.includes('thinning NOT MEASURED'), 'the reader is told the measurement is missing')

  const measured = aggregate([{ schemaVersion: 1, name: 'review', verdict: 'Approve', verification: { candidates: 2, confirmed: 2, thinned: 0 } }])
  const mw = defined(measured.workflows.find(x => x.name === 'review'))
  assert.equal(mw.thinnedMeasured, 1)
  const mline = defined(renderReport(measured).split('\n').find(l => l.startsWith('- review:')))
  assert.ok(!mline.includes('NOT MEASURED'), 'a measured zero is genuinely no thinning and says nothing')
})

test('aggregate ranks deliberate savings apart from failures, and counts revoked premises', () => {
  const saving = 'rust verification of src/lib.rs — deliberately not dispatched: the verdict was already fixed at Block, and no judgement on a Medium can move it, so those finding(s) were never checked against the code'
  const death = 'rust verification of src/other.rs — the verifier(s) died before returning a verdict, so those finding(s) were never checked against the code'
  const a = aggregate([
    { kind: 'workflow', name: 'review', verdict: 'Block', savedByFloor: [saving], savedByFloorPremiseHeld: true, notRun: [death] },
    { kind: 'workflow', name: 'review', verdict: 'Block', savedByFloor: [saving], savedByFloorPremiseHeld: true, notRun: [] },
    { kind: 'workflow', name: 'review', verdict: 'Warning (INCOMPLETE)', savedByFloor: [saving], savedByFloorPremiseHeld: false, notRun: [] },
  ])
  // The saving repeats and is countable — which is the whole point of recording it.
  assert.deepEqual(a.savedByFloor, [{ item: saving, count: 3 }])
  // And it never joins the fragility ranking: a re-run fixes a death, it repeats a saving.
  assert.deepEqual(a.notRun, [{ item: death, count: 1 }])
  // The event that decides whether the economy is SOUND, not merely how often it fires.
  assert.equal(a.savedByFloorRevokedRuns, 1)
})

test('aggregate does not read a record written before the field existed as a revoked premise', () => {
  // `undefined` is silence, not a defect. Reading it as false would invent one in every old run.
  const a = aggregate([{ kind: 'workflow', name: 'review', verdict: 'Block' }, { kind: 'workflow', name: 'review', verdict: 'Approve' }])
  assert.equal(a.savedByFloorRevokedRuns, 0)
  assert.deepEqual(a.savedByFloor, [])
})

test('aggregate surfaces a run\'s real cache-read cost when the record carries a cost object, and reads an un-enriched run as not-measured rather than zero', () => {
  const rec = {
    schemaVersion: 1, name: 'review', verdict: 'Approve', round: 1, outputTokens: 12345,
    // cacheRead is ~99% of real spend — the whole point of enrichment.
    cost: { output: 4, input: 12, cacheRead: 900000, cacheWrite: 120, total: 900136, agents: 2 },
  }
  const a = aggregate([rec])
  const w = defined(a.workflows.find(x => x.name === 'review'))
  assert.equal(w.costRuns, 1)
  assert.equal(w.avgCacheReadPerRun, 900000)
  assert.equal(w.avgCostTotalPerRun, 900136)
  // The report prints the real cost prominently, keyed on cacheRead.
  assert.match(renderReport(a), /900000 cache-read tok\/run/)

  // An un-enriched record contributes no cost and must NOT read as a zero-cost run.
  const b = aggregate([{ schemaVersion: 1, name: 'review', verdict: 'Approve', round: 1, outputTokens: 100 }])
  const wb = defined(b.workflows.find(x => x.name === 'review'))
  assert.equal(wb.costRuns, 0)
  assert.equal(wb.avgCacheReadPerRun, null)
  assert.doesNotMatch(renderReport(b), /cache-read/)
})

// tallyCost recomputes `total` from the four parts when a record carries a `cost` object but no
// `total` — a record enriched by an older writer. This closes a coverage gap on an EXISTING branch;
// it is not a red-before-fix bug and passes on the current code.
test('aggregate recomputes cost total from the four parts when a cost object has no total', () => {
  const rec = {
    schemaVersion: 1, name: 'review', verdict: 'Approve', round: 1, outputTokens: 100,
    cost: { output: 4, input: 12, cacheRead: 900000, cacheWrite: 120, agents: 2 }, // NO total
  }
  const w = defined(aggregate([rec]).workflows.find(x => x.name === 'review'))
  assert.equal(w.costRuns, 1)
  assert.equal(w.avgCostTotalPerRun, 4 + 12 + 900000 + 120) // 900136, summed from the parts
})

// ---- the version collision -------------------------------------------------------------------
// craftVersion names a RELEASE, not an engine: release-please bumps it only when it cuts a release,
// so trunk after the last release carries that release's version across byte-diverged engines
// (observed live: two runs both craftVersion 0.18.1, engineRevision 2 and 3). engineKey already
// keys the sound slice on the revision, and `--engine`/`latest` use it. The remaining gap is
// VISIBILITY: the legacy `--version` filter and the default report never flag that one version
// string spans more than one engine, so a reader slicing by version silently blends them.

/** @param {Record<string, unknown>} over */
const collisionRun = over => ({ schemaVersion: 1, runtime: 'claude-code', name: 'review', verdict: 'Approve', notRun: [], dimensions: [], ...over })

test('aggregate exposes a collision when one craftVersion carries more than one engine revision', () => {
  const a = aggregate([
    collisionRun({ craftVersion: '0.18.1', engineRevision: 3 }),
    collisionRun({ craftVersion: '0.18.1', engineRevision: 2 }),
  ])
  assert.deepEqual(a.versionCollisions, [{ version: '0.18.1', revisions: ['r2', 'r3'] }],
    'the colliding version is exposed with both revisions, ordered')
  const out = renderReport(a)
  assert.match(out, /VERSION COLLISION/, 'and it reaches a reader of the report')
  assert.match(out, /craftVersion 0\.18\.1 spans 2 engine revisions \(r2, r3\)/,
    'naming the version and both revisions')
  // Stated before the numbers, exactly like the engine boundary — a caveat under the numbers arrives
  // after the reader has already read a blended rate as a before/after.
  assert.ok(out.indexOf('VERSION COLLISION') < out.indexOf('## Workflows'))
})

test('a store where every craftVersion has a single engine revision reports no collision', () => {
  const a = aggregate([
    collisionRun({ craftVersion: '0.18.0', engineRevision: 2 }),
    collisionRun({ craftVersion: '0.18.1', engineRevision: 3 }),
    collisionRun({ craftVersion: '0.18.1', engineRevision: 3 }),
  ])
  assert.deepEqual(a.versionCollisions, [], 'each version carries exactly one revision — no collision')
  assert.ok(!/VERSION COLLISION/.test(renderReport(a)), 'and no warning is printed')
})

test('versionCollisions are ordered by SEMVER, not lexicographically', () => {
  // Two genuinely colliding versions (each carried by r2 AND r3) that a lexicographic sort would
  // INVERT: as strings '0.10.0' < '0.9.0' and '0.18.1' < '0.9.0'. Only a semver-aware order puts
  // 0.9.0 first. Detection is unaffected either way — this pins DISPLAY order.
  const a = aggregate([
    collisionRun({ craftVersion: '0.10.0', engineRevision: 2 }),
    collisionRun({ craftVersion: '0.10.0', engineRevision: 3 }),
    collisionRun({ craftVersion: '0.9.0', engineRevision: 2 }),
    collisionRun({ craftVersion: '0.9.0', engineRevision: 3 }),
  ])
  assert.deepEqual(a.versionCollisions.map(c => c.version), ['0.9.0', '0.10.0'],
    'semver order: 0.9.0 precedes 0.10.0 (a lexicographic sort would list 0.10.0 first)')
})

test('a craftVersion split between a known revision and an unattributed run is a collision', () => {
  // The unattributed run is `r?`, a distinct bucket from `r3` — the same version string covers a
  // known engine AND a run whose engine cannot be told, so a `--version` slice still blends them.
  const a = aggregate([
    collisionRun({ craftVersion: '0.18.1', engineRevision: 3 }),
    collisionRun({ craftVersion: '0.18.1' }),   // no engineRevision → r?
  ])
  assert.deepEqual(a.versionCollisions, [{ version: '0.18.1', revisions: ['r3', 'r?'] }],
    'r? sorts last, after the known revision')
})

test('the --version CLI filter warns when its slice blends multiple engine revisions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-runs-'))
  /** @param {number} rev @param {string} ts */
  const rec = (rev, ts) => ({ schemaVersion: 1, runtime: 'claude-code', name: 'review', verdict: 'Approve', craftVersion: '0.18.1', engineRevision: rev, ts, notRun: [], dimensions: [] })
  fs.writeFileSync(path.join(dir, 'a-review.json'), JSON.stringify(rec(2, '2026-01-01T00-00-00Z')))
  fs.writeFileSync(path.join(dir, 'b-review.json'), JSON.stringify(rec(3, '2026-01-02T00-00-00Z')))
  const script = fileURLToPath(new URL('./analyze-runs.mjs', import.meta.url))
  const out = execFileSync('node', [script, dir, '--version', '0.18.1'], { encoding: 'utf8' })
  fs.rmSync(dir, { recursive: true, force: true })
  assert.match(out, /Filtered to craft 0\.18\.1/, 'the version filter ran')
  assert.match(out, /This --version slice blends 2 engine revisions \(r2, r3\)/,
    'and it says the slice blends more than one engine')
  assert.match(out, /Prefer `--engine`/)
})

// ---- the surface gate (realm @nick/craft #102) -------------------------------------------------
// Three populations that must never blur into each other: a run with NO `surfaceGate` field at all
// PREDATES the feature (or belongs to an engine that never writes it) and must not read as "the gate
// ran and saved 0" — that is a measurement the run never made, the same NOT-MEASURED-IS-NOT-ZERO
// defect `thinnedMeasured` guards one field over. A run WITH `surfaceGate` and an empty `dropped` is
// a real, measured zero. A run with a non-empty `dropped` is a real saving.

const preGateRun = { schemaVersion: 1, name: 'review', verdict: 'Approve', notRun: [], dimensions: [] } // no surfaceGate at all
const gateNoDropRun = { schemaVersion: 1, name: 'review', verdict: 'Approve', notRun: [], dimensions: [], surfaceGate: { dropped: [], namedByCritic: [] } }
/** @param {string[]} dropped @param {string[]} [namedByCritic] */
const gateDropRun = (dropped, namedByCritic = []) => ({ schemaVersion: 1, name: 'review', verdict: 'Approve', notRun: [], dimensions: [], surfaceGate: { dropped, namedByCritic } })

test('the surface gate splits pre-gate, gate-present-no-drop and gate-present-with-drops into three populations', () => {
  const a = aggregate([
    preGateRun, preGateRun,
    gateNoDropRun,
    gateDropRun(['negative-space', 'compat']),
    gateDropRun(['negative-space']),
  ])
  const w = defined(a.workflows.find(x => x.name === 'review'))
  // Falsifier: conflating pre-gate with gate-present-no-drop would read sgPreGate as 3 (or sgGateRuns
  // as 5) instead of the true 2/3 split — this assertion fails under that conflation.
  assert.equal(w.sgPreGate, 2, 'the two fieldless runs are counted as PRE-GATE, not as zero-saving runs')
  assert.equal(w.sgGateRuns, 3, 'the three runs that carry the field are the gate-present population')
  assert.equal(w.sgSavedRuns, 2, 'only the runs with a non-empty dropped list saved anything')
  assert.equal(w.sgSavedPasses, 3, 'total whole-repo passes saved: 2 (negative-space+compat) + 1 (negative-space)')
  assert.deepEqual(w.sgSavedByLens, { 'negative-space': 2, compat: 1 }, 'per-lens breakdown of what was dropped')
})

test('an all-pre-gate slice renders no false "0 saved" — it reports the absence honestly instead', () => {
  const a = aggregate([preGateRun, preGateRun, preGateRun])
  const w = defined(a.workflows.find(x => x.name === 'review'))
  assert.equal(w.sgGateRuns, 0)
  assert.equal(w.sgSavedPasses, 0)
  const report = renderReport(a)
  // Falsifier: a naive implementation that folds pre-gate into "gate ran, dropped=[]" would print
  // "0 run(s) carry the gate" is avoided, or worse "3 run(s) carry the gate ... 0 saved" — either way
  // implying the gate was measured and found nothing. The report must say it was never recorded here.
  assert.match(report, /SURFACE GATE/)
  assert.match(report, /surface gate not recorded in this store/)
  assert.ok(!/run\(s\) carry the gate/.test(report), 'no population is claimed to carry the gate when none does')
})

test('a workflow with no surfaceGate field at all (e.g. adversarial-review) prints nothing for it, not an implied zero', () => {
  const a = aggregate([
    { schemaVersion: 1, name: 'adversarial-review', verdict: 'Approve', notRun: [], dimensions: [] },
    gateDropRun(['invariants']), // review DOES carry the gate in this store
  ])
  const report = renderReport(a)
  // The surface-gate section must only speak about `review` (the workflow that actually carries the
  // field) — adversarial-review gets no line in this section at all.
  const sgSection = report.slice(report.indexOf('## SURFACE GATE'))
  assert.ok(!/adversarial-review/.test(sgSection), 'a workflow with zero gate-carrying runs is silent, not zeroed')
  assert.match(sgSection, /review: 1 run\(s\) carry the gate/)
  assert.match(sgSection, /invariants 1/)
})

test('the surface-gate section names pre-gate runs mixed in the same workflow, and reports no share when neither run carries `dispatched`', () => {
  const a = aggregate([preGateRun, gateDropRun(['compat']), gateNoDropRun])
  const report = renderReport(a)
  const sgSection = report.slice(report.indexOf('## SURFACE GATE'), report.indexOf('## NOT REVIEWED'))
  assert.match(sgSection, /2 run\(s\) carry the gate \(1 run\(s\) with no gate record, excluded here\)/)
  assert.match(sgSection, /1 run\(s\) saved ≥1 pass/)
  assert.match(sgSection, /1 whole-repo pass\(es\) saved total \(compat 1\)/)
  // Neither `gateDropRun` nor `gateNoDropRun` carries `dispatched` (both predate the field), so the
  // share denominator is 0 — printed as no share at all, never a fabricated ratio.
  assert.ok(!/\d+(\.\d+)?%/.test(sgSection), 'no share percentage is fabricated')
  assert.match(sgSection, /Share: not reported — 2 run\(s\) carry the gate but predate the dispatched count/)
})

// ---- the surface-gate SHARE: saved / (saved + dispatched) --------------------------------------
// realm @nick/craft #102 follow-up: `dispatched` (the gateable lenses that actually ran, mirroring
// `dropped`) now rides on the record, so the share the deferred note above used to refuse can be
// computed — but only over the population that actually carries it.
/** @param {string[]} dropped @param {string[]} dispatched @param {string[]} [namedByCritic] */
const gateRun = (dropped, dispatched, namedByCritic = []) =>
  ({ schemaVersion: 1, name: 'review', verdict: 'Approve', notRun: [], dimensions: [], surfaceGate: { dropped, dispatched, namedByCritic } })

test('the surface-gate share is saved / (saved + dispatched), summed across every run that carries `dispatched`', () => {
  const a = aggregate([
    gateRun(['negative-space', 'compat'], ['invariants']), // saved 2, dispatched 1
    gateRun(['negative-space'], []),                       // saved 1, dispatched 0
  ])
  const report = renderReport(a)
  const sgSection = report.slice(report.indexOf('## SURFACE GATE'), report.indexOf('## NOT REVIEWED'))
  // Falsifier: the pre-change code never computes or prints a share — this fails against it.
  assert.match(sgSection, /Share \(saved \/ \(saved \+ dispatched\)\): 75%/, '3 saved + 1 dispatched = 4 total -> 75%')
  assert.match(sgSection, /3 saved, 1 dispatched/)
})

test('a gate-present run missing `dispatched` is excluded from the share denominator, not read as zero-dispatched', () => {
  const a = aggregate([
    gateDropRun(['negative-space']),        // legacy: gate-present, no `dispatched` field at all
    gateRun([], ['compat']),                // saved 0, dispatched 1 — the only run the share can see
  ])
  const report = renderReport(a)
  const sgSection = report.slice(report.indexOf('## SURFACE GATE'), report.indexOf('## NOT REVIEWED'))
  // Falsifier: reading the legacy run's missing `dispatched` as `[]` would fold its saved pass into
  // the numerator with nothing added to the denominator, inflating the share to 1/(1+1) = 50%. The
  // honest share excludes that run entirely and lands at 0/(0+1) = 0%.
  assert.match(sgSection, /Share \(saved \/ \(saved \+ dispatched\)\): 0% \(0 saved, 1 dispatched\)/)
  assert.match(sgSection, /1 run\(s\) carry the gate but predate the dispatched count, excluded from this share/)
})

test('a share denominator of 0 prints no share line at all, not a fabricated 0/0', () => {
  const a = aggregate([gateRun([], [])]) // dispatched IS present, just empty — a real, measured zero
  const report = renderReport(a)
  const sgSection = report.slice(report.indexOf('## SURFACE GATE'), report.indexOf('## NOT REVIEWED'))
  assert.ok(!/share/i.test(sgSection), 'no share of any kind is printed when saved + dispatched is 0')
})

// ---- the surface gate: a mechanically gate-FAILED run must not read as a saving ----------------
// A run whose mechanical gate failed aborts review.js before any lens dispatches — its `dropped` list
// is still planning-time output, but no lens would have run regardless, so counting it as "saved"
// invents a saving that pass never bought. The discriminator is the CONJUNCTION `gate.status ===
// 'fail'` AND `dispatched.length === 0` — never `gate.status` alone, because a healthy run that
// legitimately gated every gateable lens (gate passed, dispatched empty) is a REAL 100% saving, and a
// multi-profile run where one profile's gate failed but another dispatched is also real work.
/** @param {string[]} dropped @param {string[]} dispatched */
const gateFailRun = (dropped, dispatched) => ({
  schemaVersion: 1, name: 'review', verdict: 'Approve', notRun: [], dimensions: [],
  surfaceGate: { dropped, dispatched, namedByCritic: [] },
  gate: { status: 'fail' },
})

test('a gate-failed, nothing-dispatched run is a fictional saving and is excluded from the raw count, the share, and counted in the gate-failed note', () => {
  const a = aggregate([gateFailRun(['negative-space'], [])])
  const w = defined(a.workflows.find(x => x.name === 'review'))
  // Falsifier: pre-fix, this run folds in as `saved += 1`, `dispatched += 0`, reading as a 100% saved
  // pass and a 100% share, even though the gate never let any lens run.
  assert.equal(w.sgSavedRuns, 0, 'the aborted run must not count as a saved run')
  assert.equal(w.sgSavedPasses, 0, 'the aborted run must not count toward the raw saved-passes total')
  assert.deepEqual(w.sgSavedByLens, {}, 'the aborted run must not attribute a saving to any lens')
  assert.equal(w.sgShareSavedPasses, 0, 'the aborted run must not inflate the share numerator')
  assert.equal(w.sgDispatchedPasses, 0, 'the aborted run must not inflate the share denominator either')
  assert.equal(w.sgGateFailedRuns, 1, 'the aborted run is counted apart, in its own bucket')
  const report = renderReport(a)
  const sgSection = report.slice(report.indexOf('## SURFACE GATE'), report.indexOf('## NOT REVIEWED'))
  assert.match(sgSection, /1 run\(s\) excluded: gate failed with no surface-gated lens dispatched/)
  assert.ok(!/share/i.test(sgSection), 'no share is fabricated from a denominator of 0')
})

test('a HEALTHY all-dropped run (gate passed, nothing dispatched) is a real 100% saving and is kept, not excluded', () => {
  const healthyRun = {
    schemaVersion: 1, name: 'review', verdict: 'Approve', notRun: [], dimensions: [],
    surfaceGate: { dropped: ['negative-space', 'compat'], dispatched: [], namedByCritic: [] },
    gate: { status: 'pass' },
  }
  const a = aggregate([healthyRun])
  const w = defined(a.workflows.find(x => x.name === 'review'))
  // Falsifier: excluding on `dispatched.length === 0` alone (without requiring gate.status === 'fail')
  // would wrongly zero out this run too — this asserts it survives untouched.
  assert.equal(w.sgGateFailedRuns, 0, 'a passed gate is never counted as gate-failed')
  assert.equal(w.sgSavedRuns, 1)
  assert.equal(w.sgSavedPasses, 2)
  assert.equal(w.sgShareSavedPasses, 2)
  assert.equal(w.sgDispatchedPasses, 0)
  const report = renderReport(a)
  const sgSection = report.slice(report.indexOf('## SURFACE GATE'), report.indexOf('## NOT REVIEWED'))
  assert.match(sgSection, /Share \(saved \/ \(saved \+ dispatched\)\): 100% \(2 saved, 0 dispatched\)/)
})

test('a multi-profile run with gate.status "fail" but a non-empty `dispatched` did real work and is not excluded', () => {
  const a = aggregate([gateFailRun(['negative-space'], ['compat'])])
  const w = defined(a.workflows.find(x => x.name === 'review'))
  // Falsifier: excluding on `gate.status === 'fail'` alone (without requiring `dispatched` to be
  // empty) would wrongly zero out this run, which did real, measured work in another profile.
  assert.equal(w.sgGateFailedRuns, 0, 'gate.status alone must not trigger the exclusion')
  assert.equal(w.sgSavedRuns, 1)
  assert.equal(w.sgSavedPasses, 1)
  assert.equal(w.sgShareSavedPasses, 1)
  assert.equal(w.sgDispatchedPasses, 1)
})

// ---- the surface gate: a gate-failed run where ANOTHER profile ran its lenses (realm @nick/craft #103)
// The merged `gate.status` is worst-of across profiles, so a MIXED run can carry `status:'fail'` (rust
// profile failed its gate) together with `dispatched:[]` and a real `dropped` (nix profile passed and
// legitimately gated a surface lens with nothing left to dispatch). On gate.status + dispatched alone
// that is indistinguishable from a run where EVERY profile aborted before any lens ran. `lensesRan`
// (true when at least one profile got a lens agent back) is the third discriminator: it keeps the
// mixed run's real saving while a true all-abort — and a legacy record with no `lensesRan` field —
// stays excluded exactly as before.
/** @param {string[]} dropped @param {string[]} dispatched @param {boolean} lensesRan */
const gateFailLensesRun = (dropped, dispatched, lensesRan) => ({
  schemaVersion: 1, name: 'review', verdict: 'Approve', notRun: [], dimensions: [],
  surfaceGate: { dropped, dispatched, namedByCritic: [], lensesRan },
  gate: { status: 'fail' },
})

test('a gate-failed run where another profile ran its lenses (lensesRan true) keeps its real saving, not excluded as fictional', () => {
  const a = aggregate([gateFailLensesRun(['negative-space'], [], true)])
  const w = defined(a.workflows.find(x => x.name === 'review'))
  // Falsifier: without the `sg.lensesRan !== true` clause this run is excluded on gate.status fail +
  // dispatched empty, silently losing the passing profile's real drop. Reverting Edit 2 fails this.
  assert.equal(w.sgGateFailedRuns, 0, 'a run where a profile completed its lenses is not a fictional saving')
  assert.equal(w.sgSavedRuns, 1, 'the real drop is counted as a saving')
  assert.equal(w.sgSavedPasses, 1, 'the dropped pass reaches the raw saved-passes total')
  assert.deepEqual(w.sgSavedByLens, { 'negative-space': 1 }, 'the drop is attributed to its lens')
  assert.equal(w.sgShareSavedPasses, 1, 'the saving reaches the share numerator')
  assert.equal(w.sgDispatchedPasses, 0, 'nothing was dispatched, so the denominator gains nothing')
})

test('a true all-abort run (gate failed, nothing dispatched, lensesRan false) is still a fictional saving and stays excluded', () => {
  const a = aggregate([gateFailLensesRun(['negative-space'], [], false)])
  const w = defined(a.workflows.find(x => x.name === 'review'))
  assert.equal(w.sgGateFailedRuns, 1, 'no profile ran lenses — the run is counted apart as gate-failed')
  assert.equal(w.sgSavedRuns, 0, 'the fictional saving must not count as a saved run')
  assert.equal(w.sgSavedPasses, 0, 'the fictional saving must not reach the raw saved-passes total')
  assert.deepEqual(w.sgSavedByLens, {}, 'no lens is credited for a saving that never happened')
  assert.equal(w.sgShareSavedPasses, 0, 'the fictional saving must not inflate the share numerator')
  assert.equal(w.sgDispatchedPasses, 0)
})

test('a legacy gate-failed record with no `lensesRan` field is still excluded — backward-compat: absence reads as not-run', () => {
  const a = aggregate([gateFailRun(['negative-space'], [])]) // gate-failed, dispatched empty, NO lensesRan field
  const w = defined(a.workflows.find(x => x.name === 'review'))
  // `sg.lensesRan !== true` is true when the field is absent, so the added clause never moves an old
  // record's count: the historical gate-failed exclusion is preserved exactly.
  assert.equal(w.sgGateFailedRuns, 1, 'a fieldless legacy record keeps the old gate-failed exclusion')
  assert.equal(w.sgSavedRuns, 0)
  assert.equal(w.sgSavedPasses, 0)
})

test('loadRecords counts a record file holding valid non-object JSON as unreadable, not as a record', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-analyze-nonobj-'))
  fs.writeFileSync(path.join(dir, 'a.json'), 'null')
  fs.writeFileSync(path.join(dir, 'b.json'), '[1]')
  fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify({ kind: 'workflow', name: 'review' }))
  const { records, unreadable } = defined(loadRecords(dir))
  assert.equal(records.length, 1)
  assert.deepEqual(unreadable.map(u => u.file).sort(), ['a.json', 'b.json'])
})

test('aggregate keeps a malformed or partial cost out of the per-run cost averages and counts each', () => {
  /** @param {unknown} cost */
  const run = cost => ({ schemaVersion: 1, name: 'review', verdict: 'Approve', round: 1, outputTokens: 1, cost })
  const a = aggregate([
    run({ output: 4, input: 12, cacheRead: 1000, cacheWrite: 0, total: 1016, agents: 2 }),
    run({ output: 'x', input: 12, cacheRead: 999999, cacheWrite: 0, total: 1016, agents: 2 }),
    run({ output: 4, input: 12, cacheRead: 999999, cacheWrite: 0, total: 1000015, agents: 2, skipped: 3 }),
  ])
  const w = defined(a.workflows.find(x => x.name === 'review'))
  assert.equal(w.costRuns, 1)
  assert.equal(w.avgCacheReadPerRun, 1000)
  assert.equal(w.costMalformedRuns, 1)
  assert.equal(w.costPartialRuns, 1)
  assert.match(renderReport(a), /left out of the per-run cost: 1 malformed, 1 partial/)
})

test('a workflow whose only costs are malformed or partial still says why it has no cost figure', () => {
  /** @param {unknown} cost */
  const run = cost => ({ schemaVersion: 1, name: 'review', verdict: 'Approve', round: 1, outputTokens: 1, cost })
  const a = aggregate([run({ output: 'x', total: 10 }), run({ total: 10, skipped: 2 })])
  const w = defined(a.workflows.find(x => x.name === 'review'))
  assert.equal(w.costRuns, 0)
  assert.equal(w.avgCostTotalPerRun, null)
  assert.match(renderReport(a), /left out of the per-run cost: 1 malformed, 1 partial/)
})

test('a null total sums the parts, and an empty cost is not averaged in as a free run', () => {
  /** @param {unknown} cost */
  const run = cost => ({ schemaVersion: 1, name: 'review', verdict: 'Approve', round: 1, outputTokens: 1, cost })
  const a = aggregate([run({ total: null, cacheRead: 1000, cacheWrite: 10, input: 5, output: 5 }), run({ total: 0, cacheRead: 0, cacheWrite: 0, input: 0, output: 0, agents: 2 })])
  const w = defined(a.workflows.find(x => x.name === 'review'))
  assert.equal(w.costRuns, 1)
  assert.equal(w.avgCostTotalPerRun, 1020)
  assert.equal(w.avgCacheReadPerRun, 1000)
  assert.equal(w.costEmptyRuns, 1)
  assert.match(renderReport(a), /left out of the per-run cost: 1 that measured nothing/)
  assert.doesNotMatch(renderReport(a), /0 malformed|0 partial/)
})

test('a falsy non-object cost (0, false, empty string) is counted malformed, as round-pairs classes it', () => {
  /** @param {unknown} cost */
  const run = cost => ({ schemaVersion: 1, name: 'review', verdict: 'Approve', round: 1, outputTokens: 1, cost })
  const w = defined(aggregate([run(0), run(false), run('')]).workflows.find(x => x.name === 'review'))
  assert.equal(w.costMalformedRuns, 3)
})

// ---- the aggregate's edges, and the report line by line ------------------------------------------

/** @param {Record<string, any>[]} records @param {string} [name] */
const wfOf = (records, name = 'review') => defined(aggregate(records).workflows.find(w => w.name === name))
/** @param {Record<string, any>[]} records @param {string} [name] @returns {string} */
const workflowLineOf = (records, name = 'review') => defined(renderReport(aggregate(records)).split('\n').find(l => l.startsWith(`- ${name}: `)))
// The lines of one report section: everything after its header, up to the blank line that ends it.
/** @param {string} out @param {string} header @returns {string[]} */
const sectionOf = (out, header) => {
  const lines = out.split('\n')
  const start = lines.findIndex(l => l.startsWith(header))
  assert.ok(start >= 0, header)
  const end = lines.indexOf('', start)
  return lines.slice(start + 1, end < 0 ? undefined : end)
}

test('every severity is tallied under its own name, an absent one as zero', () => {
  const recs = [run({ dimensions: [{ dimension: 'd', findingCount: 6, bySeverity: { Critical: 1, Medium: 1, Low: 2, Info: 3 } }] })]
  const d = defined(aggregate(recs).dimensions[0])
  assert.deepEqual(d.bySeverity, { Critical: 1, High: 0, Medium: 1, Low: 2, Info: 3 })
  assert.match(renderReport(aggregate(recs)), /^- d: 6 finding\(s\) \/ 1 run\(s\) \(6\/run\) · C1 M1 L2 I3$/m)
})

test('version collisions order versions as semver and revisions by number, the unknown last', () => {
  const versions = ['0.10.0', '0.9.1', '0.9', '0.9.0', '1.0.x', '1.0.0', '1.0.0-beta', '1.0.0-alpha', '1.x.2', '1.x.1']
  const recs = versions.flatMap(v => [run({ craftVersion: v, engineRevision: 10 }), run({ craftVersion: v }), run({ craftVersion: v, engineRevision: 9 })])
  const collisions = aggregate(recs).versionCollisions
  assert.deepEqual(collisions.map(c => c.version), ['0.9', '0.9.0', '0.9.1', '0.10.0', '1.0.0', '1.0.0-alpha', '1.0.0-beta', '1.0.x', '1.x.1', '1.x.2'])
  for (const c of collisions) assert.deepEqual(c.revisions, ['r9', 'r10', 'r?'])
})

test('a collision\'s revisions order by number whichever was seen first', () => {
  const recs = [run({ craftVersion: '1', engineRevision: 9 }), run({ craftVersion: '1' }), run({ craftVersion: '1', engineRevision: 10 })]
  assert.deepEqual(defined(aggregate(recs).versionCollisions[0]).revisions, ['r9', 'r10', 'r?'])
})

test('a run with no craftVersion takes part in no version collision', () => {
  assert.deepEqual(aggregate([run({ engineRevision: 1 }), run({ engineRevision: 2 }), run({ craftVersion: '', engineRevision: 3 })]).versionCollisions, [])
})

test('the token pools: no pool without outputTokens, a non-numeric round is unclassified, each pool is a mean', () => {
  const w = wfOf([run(), run({ outputTokens: 50, round: '3' }), run({ outputTokens: 1000, round: 2 }), run({ outputTokens: 3000, round: 3 })])
  assert.equal(w.poolUnclassifiedN, 1)
  assert.equal(w.avgRunTokenPoolUnclassified, 50)
  assert.equal(w.avgRunTokenPoolReReview, 2000)
  assert.equal(w.avgRunTokenPoolFirstPass, null)
})

test('the real cost: each token kind is averaged over the usable enriched runs', () => {
  const w = wfOf([
    run({ cost: { cacheRead: 100, cacheWrite: 20, input: 30, output: 50, total: 200, agents: 1, source: 'a' } }),
    run({ cost: { cacheRead: 300, cacheWrite: 40, input: 10, output: 50, total: 400, agents: 1, source: 'b' } }),
  ])
  assert.deepEqual([w.costRuns, w.avgCacheReadPerRun, w.avgCacheWritePerRun, w.avgCostInputPerRun, w.avgCostOutputPerRun, w.avgCostTotalPerRun], [2, 200, 30, 20, 50, 300])
})

test('a surface gate that is not an object is no gate record; one without dropped saved nothing', () => {
  const w = wfOf([run({ surfaceGate: 'yes' }), run({ surfaceGate: { dispatched: [] } })])
  assert.deepEqual([w.sgPreGate, w.sgGateRuns, w.sgSavedPasses, w.sgSavedRuns], [1, 1, 0, 0])
})

test('rankings: workflows by runs, and notRun, savings, uncovered files and engines by count then name', () => {
  const recs = [
    run({ name: 'rust-audit', runtime: 'rt', craftVersion: '1', engineRevision: 5 }),
    run({ runtime: 'rt', craftVersion: '1', engineRevision: 3, notRun: ['alpha', 'zeta', 'mid'], savedByFloor: ['alpha', 'zeta', 'mid'], uncoveredFiles: ['alpha', 'zeta', 'mid'] }),
    run({ runtime: 'rt', craftVersion: '1', engineRevision: 4, notRun: ['mid'], savedByFloor: ['mid'], uncoveredFiles: ['mid'] }),
    run({ runtime: 'rt', craftVersion: '1', engineRevision: 4 }),
  ]
  const a = aggregate(recs)
  assert.deepEqual(a.workflows.map(w => w.name), ['review', 'rust-audit'])
  assert.deepEqual(a.notRun, [{ item: 'mid', count: 2 }, { item: 'alpha', count: 1 }, { item: 'zeta', count: 1 }])
  assert.deepEqual(a.savedByFloor, a.notRun)
  assert.deepEqual(a.uncoveredFiles, [{ file: 'mid', count: 2 }, { file: 'alpha', count: 1 }, { file: 'zeta', count: 1 }])
  assert.deepEqual(a.engines, [{ engine: 'rt 1 r4', runs: 2 }, { engine: 'rt 1 r3', runs: 1 }, { engine: 'rt 1 r5', runs: 1 }])
  assert.equal(a.separable, false, 'three attributed engines are not one')
})

test('a record with no name, or a verdict no pattern knows, is counted under (unknown) in no verdict bucket', () => {
  const w = wfOf([run({ name: undefined, verdict: 'Pending' })], '(unknown)')
  assert.deepEqual(w.verdicts, { block: 0, warning: 0, approve: 0, incomplete: 0 })
})

test('run-level verification: a run without a refute rate states none; only numeric counts are summed', () => {
  const w = wfOf([run({ verification: { candidates: 5, confirmed: 2 } }), run({ verification: { candidates: '7', confirmed: '1' } })])
  assert.equal(w.avgRefuteRate, null)
  assert.equal(w.refuteBasis, null)
  assert.deepEqual([w.candidates, w.confirmed], [5, 2])
})

test('an empty uncovered-file name is no uncovered file', () => {
  const a = aggregate([run({ uncoveredFiles: ['', 'a.rs'] }), run({ uncoveredFiles: [''] })])
  assert.deepEqual(a.uncoveredFiles, [{ file: 'a.rs', count: 1 }])
  assert.equal(a.uncoveredRuns, 1)
})

test('dimension rows that are not objects are skipped; an unnamed one is (unnamed)', () => {
  const a = aggregate([run({ dimensions: [null, 5, { findingCount: 1 }] })])
  assert.deepEqual(a.dimensions.map(d => [d.dimension, d.runs, d.findings]), [['(unnamed)', 1, 1]])
})

test('loadRecords names an unreadable file by its error message, cut to 80 characters', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-runs-'))
  try {
    const file = path.join(dir, `${'x'.repeat(100)}.json`)
    fs.writeFileSync(file, '{}')
    fs.chmodSync(file, 0)
    let message = ''
    try { fs.readFileSync(file, 'utf8') } catch (e) { message = String(/** @type {Error} */ (e).message) }
    if (!message) return   // a superuser reads it anyway: nothing to observe here
    const { unreadable } = defined(loadRecords(dir))
    assert.equal(defined(unreadable[0]).reason, message.slice(0, 80))
    assert.equal(defined(unreadable[0]).reason.length, 80)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the engine section: nothing to attribute, and several attributed engines with no unattributed note', () => {
  assert.deepEqual(renderEngineSection({ engines: /** @type {any} */ (undefined), unattributedRuns: 0 }), ['_No runs to attribute to an engine._'])
  const L = renderEngineSection(aggregate([run({ engineRevision: 1 }), run({ engineRevision: 2 })]))
  assert.equal(L.some(l => l.includes('carry NO engineRevision')), false)
  assert.equal(L.at(-1), 'Slice with `--engine "<runtime> <version> r<N>"` (or `--engine latest`) to compare one engine.')
})

test('workflow line: a bare run says only that thinning was not measured', () => {
  assert.equal(workflowLineOf([run()]),
    '- review: 1 run(s) · B/W/A 0/0/1 · thinning NOT MEASURED — none of these runs carried `thinned`, so the absence above is not "no thinning"')
})

test('workflow line: a mixed refute basis, thinning measured on part of the runs, pools and cost', () => {
  const cost = { cacheRead: 100, cacheWrite: 20, input: 30, output: 50, total: 200, agents: 1, source: 'a' }
  const line = workflowLineOf([
    run({ verdict: 'Block', round: 1, outputTokens: 100, verification: { refuteRate: 0.5, unverified: 0, thinned: 2 }, cost }),
    run({ verdict: 'Approve (INCOMPLETE)', round: 2, outputTokens: 300, verification: { refuteRate: 0.1 } }),
  ])
  assert.equal(line, '- review: 2 run(s) · B/W/A 1/0/0 · 1 incomplete-only · 1 partial coverage · avg refute 0.3'
    + ' · ⚠️ refute basis MIXED — some runs predate the unverified tier and count unjudged candidates inside the denominator'
    + ' · ⚠️ 2 verdict(s) on a THINNED panel across 1 run(s) — votes answered off-schema and were discarded before the arithmetic (thinning measured on 1/2 run(s))'
    + ' · ~100 tok-pool/run (first-pass) · ~300 tok-pool/run (re-review)'
    + ' · ~100 cache-read tok/run (REAL cost; ~200 tok/run total — cacheWrite 20, input 30, output 50; 1 usable enriched run(s))')
})

test('workflow line: a legacy refute basis, and thinning measured on part of the runs with none thinned', () => {
  const line = workflowLineOf([run({ verification: { refuteRate: 0.2, thinned: 0 } }), run({ verdict: 'Warning', outputTokens: 7 })])
  assert.equal(line, '- review: 2 run(s) · B/W/A 0/1/1 · avg refute 0.2 · ⚠️ refute basis LEGACY — unjudged candidates are inside this denominator'
    + ' · thinning measured on 1/2 run(s), none thinned · ~7 tok-pool/run (round not recorded)')
})

test('workflow line: thinning measured on every run adds no partial-measurement clause, thinned or not', () => {
  assert.equal(workflowLineOf([run({ verification: { refuteRate: 0, unverified: 1, thinned: 0 } })]), '- review: 1 run(s) · B/W/A 0/0/1 · avg refute 0')
  assert.equal(workflowLineOf([run({ verification: { thinned: 1 } })]),
    '- review: 1 run(s) · B/W/A 0/0/1 · ⚠️ 1 verdict(s) on a THINNED panel across 1 run(s) — votes answered off-schema and were discarded before the arithmetic')
})

test('the report: a blank line before every section header, a collision banner among them', () => {
  const lines = renderReport(aggregate([run({ craftVersion: '1', engineRevision: 1 }), run({ craftVersion: '1', engineRevision: 2 })])).split('\n')
  assert.equal(lines[1], '')
  const headers = lines.map((l, i) => [l, i]).filter(([l]) => String(l).startsWith('## '))
  assert.ok(headers.length >= 9)
  for (const [h, i] of headers) assert.equal(lines[Number(i) - 1], '', String(h))
  assert.ok(lines.includes('## SAVED — verifications deliberately not bought (highest first)'))
  const plain = renderReport({ ...aggregate([run()]), versionCollisions: /** @type {any} */ (undefined) }).split('\n')
  assert.equal(plain[plain.indexOf('## Workflows') - 1], '')
})

test('the savings and uncovered sections list at most 20 entries, and the premise line says which way it went', () => {
  const many = Array.from({ length: 25 }, (_, i) => `item-${String(i).padStart(2, '0')}`)
  const out = renderReport(aggregate([run({ savedByFloor: many, uncoveredFiles: many, savedByFloorPremiseHeld: false })]))
  const saved = sectionOf(out, '## SAVED')
  assert.equal(saved.length, 21)
  assert.equal(saved[0], '- 1× item-00')
  assert.equal(saved[20], '- ⚠️ 1 run(s) where the PREMISE DID NOT HOLD — the verdict those skips were justified by never arrived, so the findings went unverified for no reason; the engine reports those runs INCOMPLETE')
  assert.equal(sectionOf(out, '## NOT REVIEWED').length, 20)
  const empty = renderReport(aggregate([run()]))
  assert.deepEqual(sectionOf(empty, '## SAVED'), ['- none', '- premise held on every run that carries the field (a run written before it reads as silence, not as a held premise)'])
  assert.deepEqual(sectionOf(empty, '## NOT RUN'), ['- none'])
})

test('dimension lines: rate, unverified, basis caveats only over a rate, and dead runs', () => {
  const recs = [
    run({ dimensions: [
      { dimension: 'a-rated', findingCount: 4, bySeverity: { High: 4 }, confirmedCount: 3, suspectedCount: 0, refutedCount: 1, unverifiedCount: 2 },
      { dimension: 'b-legacy-rated', findingCount: 1, confirmedCount: 1, refutedCount: 1 },
      { dimension: 'c-legacy-unrated', findingCount: 0 },
      { dimension: 'd-mixed', findingCount: 0, unverifiedCount: 0 },
      { dimension: 'e-dead', ran: false },
    ] }),
    run({ dimensions: [{ dimension: 'd-mixed', findingCount: 0 }, { dimension: 'e-dead', findingCount: 0 }] }),
  ]
  assert.deepEqual(sectionOf(renderReport(aggregate(recs)), '## Dimensions'), [
    '- a-rated: 4 finding(s) / 1 run(s) (4/run) · H4 · refute 0.25 (1/4) · 2 unverified (outside the rate)',
    '- b-legacy-rated: 1 finding(s) / 1 run(s) (1/run) · — · refute 0.5 (1/2) · ⚠️ refute basis LEGACY — unjudged items are inside this denominator',
    '- c-legacy-unrated: 0 finding(s) / 1 run(s) (0/run) · —',
    '- d-mixed: 0 finding(s) / 2 run(s) (0/run) · — · ⚠️ refute basis MIXED — some rows predate the unverified tier and count unjudged items as suspected',
    '- e-dead: 0 finding(s) / 1 run(s) (0/run) · — · ⚠️ 1 run(s) it never returned',
  ])
})

/** @param {string} dimension @param {number} confirmedCount @param {number} refutedCount @param {boolean} [tracked] */
const lens = (dimension, confirmedCount, refutedCount, tracked = true) => ({ dimension, findingCount: 0, confirmedCount, refutedCount, ...(tracked ? { unverifiedCount: 0 } : {}) })

test('NOISE: rated lenses at or over the floor, highest rate then most candidates first, each with its basis', () => {
  const recs = [
    run({ dimensions: [lens('a', 2, 2), lens('b', 4, 4), lens('c', 0, 4), lens('d', 3, 1), lens('e', 0, 2), lens('f', 0, 0), lens('g', 0, 3), lens('h', 0, 6, false)] }),
    run({ dimensions: [lens('g', 0, 2, false)] }),
  ]
  const tail = 'tighten this lens\'s rubric'
  assert.deepEqual(sectionOf(renderReport(aggregate(recs)), '## NOISE'), [
    `- h: refute 1 (6/6) · 0 confirmed — ${tail} · ⚠️ refute basis LEGACY — unjudged candidates are inside this denominator, which inflates the rate; confirm before tightening`,
    `- g: refute 1 (5/5) · 0 confirmed — ${tail} · ⚠️ refute basis MIXED — some rows predate the unverified tier, so this rate is not like-for-like; confirm before tightening`,
    `- c: refute 1 (4/4) · 0 confirmed — ${tail}`,
    `- b: refute 0.5 (4/8) · 4 confirmed — ${tail}`,
    `- a: refute 0.5 (2/4) · 2 confirmed — ${tail}`,
    `- d: refute 0.25 (1/4) · 3 confirmed — ${tail}`,
  ])
})

test('NOISE: no rated lens at all, versus rated lenses all under the floor', () => {
  assert.deepEqual(sectionOf(renderReport(aggregate([run({ dimensions: [lens('f', 0, 0), lens('e', 0, 2)] })])), '## NOISE'),
    ['- no per-lens refute data yet (needs runs recorded after the per-lens telemetry landed)'])
  assert.deepEqual(sectionOf(renderReport(aggregate([run({ dimensions: [lens('f', 0, 0), lens('e', 0, 2), lens('q', 4, 0)] })])), '## NOISE'),
    ['- none — all 1 lens(es) with enough candidates refute below 0.25'])
})

test('surface gate lines: savings by lens, most first then by name, the excluded runs, and the share', () => {
  const recs = [
    run({ surfaceGate: { dropped: ['c', 'a'], dispatched: ['x'] } }),
    run({ surfaceGate: { dropped: ['b', 'a'] } }),
    run(),
    run({ gate: { status: 'fail' }, surfaceGate: { dropped: ['z'], dispatched: [] } }),
    run({ name: 'other', surfaceGate: { dropped: ['a'], dispatched: ['x', 'y', 'z'] } }),
    run({ name: 'quiet', surfaceGate: { dropped: [], dispatched: ['x'] } }),
  ]
  assert.deepEqual(sectionOf(renderReport(aggregate(recs)), '## SURFACE GATE'), [
    '- review: 3 run(s) carry the gate (1 run(s) with no gate record, excluded here) · 2 run(s) saved ≥1 pass · 4 whole-repo pass(es) saved total (a 2, b 1, c 1) (1 run(s) excluded: gate failed with no surface-gated lens dispatched)',
    '  Share (saved / (saved + dispatched)): 66.67% (2 saved, 1 dispatched) — 1 run(s) carry the gate but predate the dispatched count, excluded from this share',
    '- other: 1 run(s) carry the gate · 1 run(s) saved ≥1 pass · 1 whole-repo pass(es) saved total (a 1)',
    '  Share (saved / (saved + dispatched)): 25% (1 saved, 3 dispatched)',
    '- quiet: 1 run(s) carry the gate · 0 run(s) saved ≥1 pass · 0 whole-repo pass(es) saved total',
    '  Share (saved / (saved + dispatched)): 0% (0 saved, 1 dispatched)',
  ])
})
