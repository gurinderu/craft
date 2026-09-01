import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
    totalRuns: 0, incompleteRuns: 0, uncoveredRuns: 0, workflows: [], notRun: [], uncoveredFiles: [],
    dimensions: [], engines: [], unattributedRuns: 0, separable: true,
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
  assert.equal(review.avgOutputTokens, 750)      // (1000 + 500) / 2
  const audit = a.workflows.find(w => w.name === 'rust-audit')
  assert.equal(audit.verdicts.block, 1)
  assert.equal(audit.avgRefuteRate, 0.67)
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

test('an empty aggregate does not claim to be one comparable engine', () => {
  const a = aggregate([])
  assert.deepEqual(a.engines, [])
  assert.equal(a.separable, true)
  assert.match(renderReport(a), /## ⚠️ ENGINE BOUNDARY — this aggregate spans 0 engine build\(s\)/)
})
