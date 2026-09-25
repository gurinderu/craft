import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { aggregate, renderReport, loadRecords, partitionByCompleteness } from './analyze-runs.mjs'

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
  const review = a.workflows.find(w => w.name === 'review')
  // `Approve (INCOMPLETE)` counts as incomplete ONLY — an incomplete run is not an approve, and
  // counting it in both columns inflated the approve figure into a coverage claim.
  assert.deepEqual(review.verdicts, { block: 0, warning: 1, approve: 0, incomplete: 1 })
  assert.equal(review.avgRefuteRate, 0.3)        // (0.6 + 0) / 2
  // Neither record carries `round`, so neither is first-pass OR re-review — both land in the
  // Unclassified pool. Reading a round-less run as first-pass is the very defect the split guards.
  assert.equal(review.avgRunTokenPoolFirstPass, null)
  assert.equal(review.avgRunTokenPoolReReview, null)
  assert.equal(review.avgRunTokenPoolUnclassified, 750)   // (1000 + 500) / 2
  const audit = a.workflows.find(w => w.name === 'rust-audit')
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
  const mk = (round, outputTokens) => ({ schemaVersion: 1, name: 'review', verdict: 'Warning', notRun: [], dimensions: [], round, outputTokens })
  // Two first-pass runs (round 1) at a small pool; one re-review (round 2) at a structurally larger one.
  const a = aggregate([mk(1, 1000), mk(1, 2000), mk(2, 9000)])
  const review = a.workflows.find(w => w.name === 'review')
  assert.equal(review.avgRunTokenPoolFirstPass, 1500, 'first-pass pool averages only the round-1 runs')
  assert.equal(review.avgRunTokenPoolReReview, 9000, 'the re-review pool is reported apart, not folded in')
  // The blended figure the old code produced would be (1000+2000+9000)/3 = 4000 — a number that is
  // neither pool and calls a re-review-inflated total "output". It must not exist as a single field.
  assert.equal(review.avgOutputTokens, undefined, 'the blended, mislabelled "output" average is gone')
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
  const mk = outputTokens => ({ schemaVersion: 1, name: 'rust-audit', verdict: 'Approve', notRun: [], dimensions: [], outputTokens })
  const a = aggregate([mk(3000), mk(5000)])
  const audit = a.workflows.find(w => w.name === 'rust-audit')
  assert.equal(audit.avgRunTokenPoolFirstPass, null, 'round-less runs are NOT first-pass')
  assert.equal(audit.avgRunTokenPoolReReview, null, 'and there is no re-review pool to invent')
  assert.equal(audit.avgRunTokenPoolUnclassified, 4000, 'they form one unclassified pool')
  const line = renderReport(a).split('\n').find(l => l.startsWith('- rust-audit:'))
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
  const mk = (round, outputTokens) => ({ schemaVersion: 1, name: 'review', verdict: 'Warning', notRun: [], dimensions: [], round, outputTokens })
  const noRound = outputTokens => ({ schemaVersion: 1, name: 'review', verdict: 'Warning', notRun: [], dimensions: [], outputTokens })
  const a = aggregate([mk(1, 1000), mk(1, 2000), mk(2, 9000), noRound(8000)])
  const review = a.workflows.find(w => w.name === 'review')
  assert.equal(review.avgRunTokenPoolFirstPass, 1500, 'first-pass averages only the round==1 runs, not the round-less one')
  assert.equal(review.avgRunTokenPoolReReview, 9000, 'the re-review pool is the round>1 run')
  assert.equal(review.avgRunTokenPoolUnclassified, 8000, 'the round-less re-review is held apart, never folded into first-pass')
  assert.equal(review.poolUnclassifiedN, 1, 'and its sample size is carried so the caveat can name it')
  const line = renderReport(a).split('\n').find(l => l.startsWith('- review:'))
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
  const line = renderReport(aggregate([REVIEW_1, REVIEW_2])).split('\n').find(l => l.startsWith('- review:'))
  assert.match(line, /~750 tok-pool\/run \(round not recorded\)/, 'the round-less pool is labelled, not a bare figure')
  assert.ok(!/first-pass/.test(line), 'no phantom (first-pass) label')
  assert.ok(!/re-review/.test(line), 'and no phantom (re-review) label')
})

// F2: the rendered pool clause must never assert a CAUSE for a round-less run. It is false that a
// round-less `review` run "predates the `round` field" — `review` has current early-exit paths that
// stamp `outputTokens` with no `round`, so a round-less run is often a current early-exit, not a
// historical record. The label names the observable property (no round recorded), never a cause.
test('the rendered pool clause never asserts a cause for a round-less run', () => {
  const mk = (round, outputTokens) => ({ schemaVersion: 1, name: 'review', verdict: 'Warning', notRun: [], dimensions: [], round, outputTokens })
  const noRound = outputTokens => ({ schemaVersion: 1, name: 'review', verdict: 'Warning', notRun: [], dimensions: [], outputTokens })
  const out = renderReport(aggregate([mk(1, 1000), mk(2, 9000), noRound(8000)]))
  assert.ok(!/predate/.test(out), 'no rendered clause claims a round-less run "predates" anything')
})

test('a clean Approve still lands in the approve bucket, and only there', () => {
  const a = aggregate([{ schemaVersion: 1, name: 'review', verdict: 'Approve', notRun: [], dimensions: [] }])
  const review = a.workflows.find(w => w.name === 'review')
  assert.deepEqual(review.verdicts, { block: 0, warning: 0, approve: 1, incomplete: 0 })
  assert.equal(a.incompleteRuns, 0)
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
  const safety = a.dimensions.find(d => d.dimension === 'rust:safety')
  assert.equal(safety.runs, 2)              // appeared in REVIEW_1 and REVIEW_2
  assert.equal(safety.findings, 1)
  assert.equal(safety.findingsPerRun, 0.5)
  const security = a.dimensions.find(d => d.dimension === 'security')
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
  const api = a.dimensions.find(d => d.dimension === 'rust:api-idioms')
  assert.equal(api.candidates, 8)          // 1 + 1 + 6
  assert.equal(api.refuted, 6)
  assert.equal(api.refuteRate, 0.75)       // 6 / 8
  const safety = a.dimensions.find(d => d.dimension === 'rust:safety')
  assert.equal(safety.refuteRate, 0)       // 0 / 2
})

test('dimensions without per-lens counts get refuteRate null (old-schema records)', () => {
  const safety = aggregate([REVIEW_1]).dimensions.find(d => d.dimension === 'rust:safety')
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
  const mk = ran => ({
    schemaVersion: 1, name: 'review', verdict: 'Warning', outputTokens: 100, notRun: [],
    dimensions: [{ dimension: 'rust:ownership', ran, findingCount: ran ? 4 : 0, bySeverity: { Critical: 0, High: 0, Medium: 0, Low: ran ? 4 : 0, Info: 0 } }],
  })
  // One run where it worked and found 4; two where it never returned.
  const own = aggregate([mk(true), mk(false), mk(false)]).dimensions.find(d => d.dimension === 'rust:ownership')
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
  const d = aggregate([legacy]).dimensions.find(x => x.dimension === 'rust:safety')
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
  const { records, unreadable } = loadRecords(dir)
  assert.equal(records.length, 1, 'only the parseable record is loaded')
  assert.equal(unreadable.length, 1, 'the truncated one is reported, not dropped')
  assert.equal(unreadable[0].file, 'b-workflow-review.json')
  assert.ok(unreadable[0].reason, 'carries the parse error')
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
  const mk = verdict => ({ schemaVersion: 1, name: 'review', verdict, notRun: [], dimensions: [] })
  const records = [
    mk('Block (INCOMPLETE)'), mk('Warning (INCOMPLETE)'), mk('Approve (INCOMPLETE)'),
    mk('INCOMPLETE'), mk('Block'), mk('Warning'), mk('Approve'), mk('Healthy'), mk('At-risk'),
  ]
  const a = aggregate(records)
  const w = a.workflows.find(x => x.name === 'review')
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
  const mk = verdict => ({ schemaVersion: 1, name: 'review', verdict, notRun: [], dimensions: [] })
  const a = aggregate(Array.from({ length: 10 }, () => mk('Block (INCOMPLETE)')))
  const out = renderReport(a)
  const header = out.split('\n')[0]
  const row = out.split('\n').find(l => l.startsWith('- review:'))
  assert.match(header, /10 run\(s\), 10 with partial coverage/)
  assert.ok(!/10 incomplete$/.test(header), 'the header must not call the overlap total "incomplete"')
  assert.match(row, /B\/W\/A 10\/0\/0/)
  assert.match(row, /10 partial coverage/, 'the row must surface the overlap the header counts')
  assert.ok(!/incomplete-only/.test(row), 'the exclusive bucket is empty here and must not be printed')

  // And the exclusive bucket keeps its own distinct label.
  const b = aggregate([mk('INCOMPLETE'), mk('Approve (INCOMPLETE)')])
  const brow = renderReport(b).split('\n').find(l => l.startsWith('- review:'))
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
  const d = aggregate([UNVERIFIED_TIER]).dimensions.find(x => x.dimension === 'rust:safety')
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
  assert.equal(aggregate([legacyRow]).dimensions[0].refuteBasis, 'legacy')
  assert.equal(aggregate([UNVERIFIED_TIER, legacyRow]).dimensions[0].refuteBasis, 'mixed',
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
  const d = aggregate([allDead]).dimensions[0]
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
  assert.equal(a.workflows[0].refuteBasis, 'legacy', 'the run-level basis is reported, not only the per-lens one')
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
  assert.equal(aggregate([strictRun]).workflows[0].refuteBasis, 'strict')
  assert.equal(aggregate([strictRun, legacyRun]).workflows[0].refuteBasis, 'mixed',
    'one workflow averaging both sides of the change is not comparable with itself')
  assert.ok(!/refute basis/i.test(renderReport(aggregate([strictRun]))),
    'a caveat on every row is a caveat nobody reads')
})

// THINNED PANELS ONLY RANK IF SOMETHING AGGREGATES THEM. The engine records
// `verification.thinned` — verdicts reached after a returned vote was discarded as off-schema —
// precisely because fragility is legible as a REPEAT. That claim held nowhere until this reader
// summed it: neither this aggregate nor the index projection carried the field.
test('aggregate sums thinned panels across runs and names them in the report', () => {
  const rec = (thinned, verdict = 'Approve') => ({
    schemaVersion: 1, name: 'review', verdict, notRun: [], dimensions: [],
    verification: { candidates: 4, confirmed: 1, refuteRate: 0.2, unverified: 0, thinned },
  })
  const a = aggregate([rec(2), rec(1), rec(0)])
  const review = a.workflows.find(w => w.name === 'review')
  assert.equal(review.thinned, 3, 'the verdicts decided on a thinned panel are summed')
  assert.equal(review.thinnedRuns, 2, 'over the runs that had any — a run with none is not one of them')
  assert.match(renderReport(a), /3 verdict\(s\) on a THINNED panel across 2 run\(s\)/, 'and the reader of the report is told')
})

test('aggregate leaves thinned at zero for records that predate the counter', () => {
  const a = aggregate([{ schemaVersion: 1, name: 'review', verdict: 'Approve', notRun: [], dimensions: [], verification: { candidates: 1, confirmed: 1, refuteRate: 0 } }])
  const review = a.workflows.find(w => w.name === 'review')
  assert.equal(review.thinned, 0)
  assert.equal(review.thinnedRuns, 0)
  assert.ok(!/THINNED panel/.test(renderReport(a)), 'and claims nothing about a field the record does not carry')
})

// NOT MEASURED IS NOT ZERO: only `review` stamps `verification.thinned`, so for any other engine the
// thinning clause is absent for want of a measurement and used to read as a clean panel.
test('the workflow row says thinning was not measured rather than staying silent', () => {
  const rec = ver => ({ schemaVersion: 1, name: 'rust-audit', verdict: 'Approve', verification: ver })
  const a = aggregate([rec({ candidates: 2, confirmed: 1 }), rec({ candidates: 2, confirmed: 2 })])
  const w = a.workflows.find(x => x.name === 'rust-audit')
  assert.equal(w.thinnedMeasured, 0)
  const line = renderReport(a).split('\n').find(l => l.startsWith('- rust-audit:'))
  assert.ok(line.includes('thinning NOT MEASURED'), 'the reader is told the measurement is missing')

  const measured = aggregate([{ schemaVersion: 1, name: 'review', verdict: 'Approve', verification: { candidates: 2, confirmed: 2, thinned: 0 } }])
  const mw = measured.workflows.find(x => x.name === 'review')
  assert.equal(mw.thinnedMeasured, 1)
  const mline = renderReport(measured).split('\n').find(l => l.startsWith('- review:'))
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
  const w = a.workflows.find(x => x.name === 'review')
  assert.equal(w.costRuns, 1)
  assert.equal(w.avgCacheReadPerRun, 900000)
  assert.equal(w.avgCostTotalPerRun, 900136)
  // The report prints the real cost prominently, keyed on cacheRead.
  assert.match(renderReport(a), /900000 cache-read tok\/run/)

  // An un-enriched record contributes no cost and must NOT read as a zero-cost run.
  const b = aggregate([{ schemaVersion: 1, name: 'review', verdict: 'Approve', round: 1, outputTokens: 100 }])
  const wb = b.workflows.find(x => x.name === 'review')
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
  const w = aggregate([rec]).workflows.find(x => x.name === 'review')
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
const gateDropRun = (dropped, namedByCritic = []) => ({ schemaVersion: 1, name: 'review', verdict: 'Approve', notRun: [], dimensions: [], surfaceGate: { dropped, namedByCritic } })

test('the surface gate splits pre-gate, gate-present-no-drop and gate-present-with-drops into three populations', () => {
  const a = aggregate([
    preGateRun, preGateRun,
    gateNoDropRun,
    gateDropRun(['negative-space', 'compat']),
    gateDropRun(['negative-space']),
  ])
  const w = a.workflows.find(x => x.name === 'review')
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
  const w = a.workflows.find(x => x.name === 'review')
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
const gateFailRun = (dropped, dispatched) => ({
  schemaVersion: 1, name: 'review', verdict: 'Approve', notRun: [], dimensions: [],
  surfaceGate: { dropped, dispatched, namedByCritic: [] },
  gate: { status: 'fail' },
})

test('a gate-failed, nothing-dispatched run is a fictional saving and is excluded from the raw count, the share, and counted in the gate-failed note', () => {
  const a = aggregate([gateFailRun(['negative-space'], [])])
  const w = a.workflows.find(x => x.name === 'review')
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
  const w = a.workflows.find(x => x.name === 'review')
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
  const w = a.workflows.find(x => x.name === 'review')
  // Falsifier: excluding on `gate.status === 'fail'` alone (without requiring `dispatched` to be
  // empty) would wrongly zero out this run, which did real, measured work in another profile.
  assert.equal(w.sgGateFailedRuns, 0, 'gate.status alone must not trigger the exclusion')
  assert.equal(w.sgSavedRuns, 1)
  assert.equal(w.sgSavedPasses, 1)
  assert.equal(w.sgShareSavedPasses, 1)
  assert.equal(w.sgDispatchedPasses, 1)
})
