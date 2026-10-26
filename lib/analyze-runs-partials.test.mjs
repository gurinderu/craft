// The report's "did not finish" section under a slice, and without one.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run } from './analyze-runs.mjs'

const HEAD = 'abcdef0123456789abcdef0123456789abcdef01'
/** @param {Record<string, unknown>} over */
const record = over => ({
  schemaVersion: 1, kind: 'workflow', name: 'review', verdict: 'Approve', runtime: 'claude-code', craftVersion: '1.0.0',
  engineRevision: 3, ts: '2026-01-01T00-00-00Z', findings: { total: 0, bySeverity: {} }, dimensions: [],
  verification: { candidates: 0, confirmed: 0 }, project: '/p', branch: 'b', ...over,
})

/** @param {Record<string, unknown>[]} recs @returns {string} */
function store(recs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-arp-'))
  recs.forEach((r, i) => fs.writeFileSync(path.join(dir, `${i}.json`), JSON.stringify(r)))
  return dir
}

const recs = [
  record({ head: 'old' }),
  record({ craftVersion: '2.0.0', ts: '2026-02-01T00-10-00Z', head: HEAD, phases: [{ at: '2026-02-01T00:00:00Z' }] }),
  record({ partial: true, craftVersion: undefined, ts: '2026-01-15T00-00-00Z', partialReason: 'mine', phases: [{ craftVersion: '2.0.0' }] }),
  record({ partial: true, craftVersion: undefined, ts: '2026-01-16T00-00-00Z', partialReason: 'older engine' }),
  record({ partial: true, craftVersion: '1.0.0', ts: '2026-01-17T00-00-00Z', partialReason: 'v1' }),
  record({ partial: true, craftVersion: undefined, ts: '2026-02-01T00-05-00Z', head: HEAD.slice(0, 8), partialReason: 'twin' }),
]

test('--engine latest lists only that engine\'s unfinished runs, and says what it could not attribute or hid', async () => {
  const dir = store(recs)
  try {
    const out = (await run([dir, '--engine', 'latest'], process.env)).stdout.join('\n')
    assert.match(out, /did not finish — 1\b/)
    assert.match(out, /— mine/)
    assert.doesNotMatch(out, /— v1|— older engine|— twin/)
    assert.match(out, /1 unfinished record\(s\) could not be attributed to engine claude-code 2\.0\.0 r3/)
    assert.match(out, /1 rebuilt record\(s\) hidden: the same run later wrote its complete record/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('--version slices the section the same way', async () => {
  const dir = store(recs)
  try {
    const out = (await run([dir, '--version', '1.0.0'], process.env)).stdout.join('\n')
    assert.match(out, /did not finish — 1\b/)
    assert.match(out, /— v1/)
    assert.match(out, /1 unfinished record\(s\) could not be attributed to craft 1\.0\.0/)
    // The twin's run is a 2.0.0 run: hidden, but not this slice's to mention.
    assert.doesNotMatch(out, /rebuilt record/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('with no slice every unfinished run is listed but the rebuilt twin', async () => {
  const dir = store(recs)
  try {
    const out = (await run([dir], process.env)).stdout.join('\n')
    assert.match(out, /did not finish — 3\b/)
    assert.doesNotMatch(out, /could not be attributed/)
    assert.match(out, /1 rebuilt record\(s\) hidden/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
