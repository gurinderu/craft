// Aggregation guards for lib/analyze-runs.mjs.
//
// The defect under test: uncovered files used to be folded into `notRun` as one note embedding a
// count and up to five file names. `notRun` is ranked by EXACT STRING to surface repeated
// fragility, so every run contributed a unique key — the ranking filled with count-1 rows and the
// genuinely repeated failures sank. It was also the opposite claim: every other notRun entry is a
// failure a re-run can fix, while an uncovered file will never be reviewed by re-running.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aggregate, renderReport } from './analyze-runs.mjs'

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
