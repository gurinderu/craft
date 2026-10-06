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
