// The run-store report as a command, run in-process (realm @nick/craft, #172): which store it reads, which
// flags consume a value, and that every outcome — even "nothing to read" — exits 0.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run } from './analyze-runs.mjs'

/** @param {Record<string, unknown>} over */
const record = over => ({
  schemaVersion: 1, kind: 'workflow', name: 'review', verdict: 'Approve', craftVersion: '1.0.0', engineRevision: 3,
  ts: '2026-01-01T00-00-00Z', findings: { total: 0, bySeverity: {} }, dimensions: [], verification: { candidates: 0, confirmed: 0 },
  ...over,
})

/** @param {Record<string, unknown>[]} recs @returns {string} */
function store(recs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-ar-'))
  recs.forEach((r, i) => fs.writeFileSync(path.join(dir, `${i}.json`), JSON.stringify(r)))
  return dir
}

test('a missing store is reported, not failed', async () => {
  const dir = path.join(os.tmpdir(), 'craft-ar-no-such-store')
  const r = await run([dir], process.env)
  assert.equal(r.exitCode, 0)
  assert.ok(r.stdout[0]?.includes(dir))
})

test('with no directory it reads .craft/runs under the home it is given', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-ar-home-'))
  try {
    const r = await run([], process.env, home)
    assert.ok(r.stdout[0]?.includes(path.join(home, '.craft', 'runs')))
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

test('--version and --engine consume their value: it is never taken for the store', async () => {
  const dir = store([record({}), record({ craftVersion: '2.0.0', ts: '2026-02-01T00-00-00Z' })])
  try {
    for (const argv of [['--version', '1.0.0', dir], ['--engine', 'x', dir]]) {
      const r = await run(argv, process.env)
      assert.equal(r.exitCode, 0)
      assert.ok(!r.stdout.join('\n').includes('No run store'), argv.join(' '))
    }
    const v = await run(['--version=1.0.0', dir], process.env)
    assert.match(v.stdout.join('\n'), /1 of 2 run\(s\)/)
    const e = await run([dir, '--engine=nope'], process.env)
    assert.equal(e.stdout.length, 1, 'an engine that matches nothing ends the report')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('partial, legacy and unreadable records are counted out loud, never averaged in', async () => {
  const dir = store([record({}), record({ partial: true, partialReason: 'died' }), { kind: 'workflow' }])
  fs.writeFileSync(path.join(dir, 'broken.json'), '{')
  try {
    const out = (await run([dir], process.env)).stdout.join('\n')
    assert.match(out, /1 record\(s\) skipped/)
    assert.match(out, /did not finish — 1/)
    assert.match(out, /Unreadable records — 1/)
    const pairs = await run([dir, '--round-pairs', '--engine', 'x'], process.env)
    assert.equal(pairs.exitCode, 0)
    assert.match(pairs.stdout.join('\n'), /ignored with --round-pairs[\s\S]*Unreadable records — 1/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('an empty store has no newest engine to pick, and says so', async () => {
  const dir = store([])
  try {
    const r = await run([dir, '--engine'], process.env)
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout.length, 1, 'one line, and no report over nothing')
    assert.deepEqual(r.stderr, [])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('a resumed run filed twice is one run, and the fold is said (realm @nick/craft, #249)', async () => {
  const same = { project: '/p', branch: 'feat/x', head: 'abc', filesDigest: 'd1', round: 1, findings: { total: 2, bySeverity: { Low: 2 } } }
  const dir = store([
    record({ ...same, ts: '2026-01-01T00-00-00Z', verdict: 'Warning' }),
    record({ ...same, ts: '2026-01-01T01-00-00Z', verdict: 'Warning' }),
    record({ ...same, filesDigest: 'd2', ts: '2026-01-01T02-00-00Z' }),
    record({ ...same, filesDigest: undefined, ts: '2026-01-01T03-00-00Z' }),
  ])
  try {
    const out = (await run([dir], process.env)).stdout.join('\n')
    assert.match(out, /3 run\(s\)/)
    assert.match(out, /1 record\(s\) folded into a newer record of the same run/)
    assert.doesNotMatch(out, /record\(s\) skipped: no schemaVersion/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('--round-pairs pairs a resumed round once, not once per record (realm @nick/craft, #249)', async () => {
  /** @param {number} round @param {string} ts @returns {Record<string, unknown>} */
  const roundRec = (round, ts) => record({
    runtime: 'claude-code', engineRevision: 4, project: '/p', branch: 'feat/x', head: 'aaa', round, ts, filesDigest: 'f',
    findings: { total: 3, bySeverity: { Medium: 3 } }, lensRounds: [{ round: 1, agents: 20, returned: 20, newFindings: 5 }],
    dirty: false, lensScope: 'full', base: 'main', path: '', strict: false, intentDigest: '7', specDigest: 's',
    reReview: round > 1 ? { chained: true, fpComparable: true, priorRound: round - 1, priorHead: 'aaa' } : { chained: false },
  })
  const dir = store([roundRec(1, '2026-01-01T00-00-00Z'), roundRec(2, '2026-01-02T00-00-00Z'), roundRec(2, '2026-01-02T01-00-00Z')])
  try {
    const out = (await run([dir, '--round-pairs'], process.env)).stdout.join('\n')
    assert.equal((out.match(/round 1 → 2/g) || []).length, 1, out)
    assert.match(out, /1 record\(s\) folded into a newer record of the same run before pairing/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('the report carries the start hook section, joined by repo, read from the home it is given', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-ar-hook-'))
  try {
    const runs = path.join(home, '.craft', 'runs')
    fs.mkdirSync(runs, { recursive: true })
    fs.writeFileSync(path.join(runs, 'a.json'), JSON.stringify(record({ project: '/r/a' })))
    fs.writeFileSync(path.join(home, '.craft', 'hooks.jsonl'), `${JSON.stringify({ ts: 't', repo: '/r/a', source: 'startup', spoke: true, found: ['AGENTS.md'], silent: null })}\n`)
    const out = (await run([], process.env, home)).stdout.join('\n')
    assert.match(out, /## Start hook/)
    assert.match(out, /review runs from repos where the hook spoke: 1 of 1/)
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})
