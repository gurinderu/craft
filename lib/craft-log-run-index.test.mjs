// The operator commands over the store, pinned at their edges: backfill-engine's cut and file set,
// repair-index's block handling and sidecar, the atomic write's failure, enrich-cost's transcript set
// and warnings, and the README the store keeps.
import { test, vi, onTestFinished } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  backfillEngineRevision, compactPrettyBlock, indexKey, blockFields, repairIndex, writeFileAtomically, enrichCost, writeRecord,
} from './craft-log-run.mjs'

const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-index-edges-'))
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
const NOW = new Date('2026-10-02T12:00:00Z')
/** @param {() => unknown} fn @returns {string[]} */
const stderrOf = fn => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    fn()
    return spy.mock.calls.map(c => String(c[0]))
  } finally {
    spy.mockRestore()
  }
}

test('backfill reads only record files, in name order, and a record stamped exactly at the cut is after it', () => {
  const store = tmp()
  for (const ts of ['2026-08-03T00-00-00Z', '2026-08-01T00-00-00Z', '2026-08-02T00-00-00Z']) fs.writeFileSync(path.join(store, `${ts}-workflow-review.json`), JSON.stringify({ ts }))
  fs.writeFileSync(path.join(store, 'at-cut.json'), JSON.stringify({ ts: '2026-09-01T20-08-31Z' }))
  fs.writeFileSync(path.join(store, 'README.md'), '# not a record')
  fs.writeFileSync(path.join(store, 'index.jsonl'), '{"ts":"2026-08-01T00-00-00Z"}\n')
  const out = backfillEngineRevision({ store, revision: 1, before: '2026-09-01T20:08:31Z' })
  assert.deepEqual(out.stamped, ['2026-08-01T00-00-00Z-workflow-review.json', '2026-08-02T00-00-00Z-workflow-review.json', '2026-08-03T00-00-00Z-workflow-review.json'])
  assert.deepEqual(out.afterCut, ['at-cut.json'])
  assert.deepEqual(out.unreadable, [])
})

test('backfill names an unreadable record by its error, cut to 80 characters', { skip: process.getuid?.() === 0 }, () => {
  const store = tmp()
  const file = path.join(store, `${'x'.repeat(100)}.json`)
  fs.writeFileSync(file, '{}')
  fs.chmodSync(file, 0)
  const [u] = backfillEngineRevision({ store, revision: 1, before: '2026-09-01T20:08:31Z' }).unreadable
  assert.equal(u?.reason.length, 80)
  assert.match(String(u?.reason), /^EACCES/)
})

test('compactPrettyBlock joins lines with newlines and accepts only a plain object', () => {
  assert.equal(compactPrettyBlock(['{"a":"x', 'y"}']), null, 'a newline inside a string is not JSON')
  assert.equal(compactPrettyBlock(['5']), null)
  assert.equal(compactPrettyBlock(['null']), null)
})

test('indexKey: the run identity once ts or name is known, raw bytes otherwise', () => {
  assert.equal(indexKey({}), 'raw\u0000')
  assert.equal(indexKey({ name: 'n' }), 'id\u0000\u0000\u0000n\u0000')
  assert.equal(indexKey({ ts: 't', kind: 'k' }), 'id\u0000t\u0000k\u0000\u0000')
})

test('blockFields reads the raw block as one newline-joined text, commit and verdict included', () => {
  assert.deepEqual(blockFields(['{"ts": "a', '", "commit": "c1", "verdict": "Block"']), { ts: 'a\n', commit: 'c1', verdict: 'Block' })
})

/** @param {string} store @param {string} text */
const index = (store, text) => fs.writeFileSync(path.join(store, 'index.jsonl'), text)

test('repair: a last line with no trailing newline is still a line', () => {
  const store = tmp()
  index(store, '{"ts":"a"}\n{"ts":"b"}')
  assert.equal(repairIndex({ store }).linesBefore, 2)
})

test('repair: a blank line is kept in place, ends a block, and is not a kept JSON line', () => {
  const store = tmp()
  index(store, '{"ts":"a"}\n  \n{"a":\n  \n1}\n')
  const r = repairIndex({ store })
  assert.deepEqual([r.parsedBefore, r.recovered.length, r.quarantined.length], [1, 0, 2])
})

test('repair: a non-object JSON line is quarantined alone, with its bytes and what they say', () => {
  const store = tmp()
  index(store, '{"ts":"a"}\n[{"ts": "t1"}]\n')
  const [q] = repairIndex({ store }).quarantined
  assert.deepEqual([q?.lines, q?.what, q?.from, q?.to], [['[{"ts": "t1"}]'], 'ts=t1', 2, 2])
})

test('repair: a block that cannot join is flagged when its ts, or its name alone, is already in the index', () => {
  const store = tmp()
  index(store, '{"ts":"t1"}\n{"name":"n1"}\n{"ts": "t1",\n"x": \n\n{"name": "n1",\n"x": \n')
  const reasons = repairIndex({ store }).quarantined.map(q => q.reason)
  assert.deepEqual(reasons, [
    'does not join into one JSON object — and its run is ALREADY in the index; do not complete it by hand',
    'does not join into one JSON object — and its run is ALREADY in the index; do not complete it by hand',
  ])
})

test('repair: the second of two identical joinable blocks is a duplicate, quarantined at its own lines', () => {
  const store = tmp()
  index(store, '{"ts":"a"}\n{\n"ts": "b"\n}\n\n{\n"ts": "b"\n}\n')
  const r = repairIndex({ store })
  assert.deepEqual(r.recovered, [{ from: 2, to: 4, line: '{"ts":"b"}' }])
  assert.deepEqual(r.quarantined.map(q => [q.from, q.to, q.reason]), [[6, 8, 'duplicates a run already in the index']])
})

test('repair --apply: no sidecar when nothing is quarantined; the sidecar lists each block under its header', () => {
  const clean = tmp()
  index(clean, '{"ts":"a"}\n{\n"ts": "b"\n}\n')
  assert.equal(repairIndex({ store: clean, apply: true, now: NOW }).quarantineFile, null)
  const store = tmp()
  index(store, '{"ts":"a"}\n42\n{"a":\n')
  const r = repairIndex({ store, apply: true, now: NOW })
  assert.equal(fs.readFileSync(String(r.quarantineFile), 'utf8'), [
    '# index.jsonl lines 2-2 — valid JSON but not a JSON object; moved out by repair-index at 2026-10-02T12-00-00Z',
    '# block: (no recognisable fields)',
    '42',
    '# index.jsonl lines 3-3 — does not join into one JSON object; moved out by repair-index at 2026-10-02T12-00-00Z',
    '# block: (no recognisable fields)',
    '{"a":',
    '',
  ].join('\n'))
})

test('an atomic write into a missing directory fails with the write\'s own error, not the cleanup\'s', () => {
  assert.throws(() => writeFileAtomically(path.join(tmp(), 'missing', 'x.json'), 'y'), /ENOENT: no such file or directory, open /)
})

/** @param {number} out */
const usage = out => JSON.stringify({ type: 'assistant', message: { usage: { output_tokens: out, input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })

test('enrich-cost: no transcript is said as such', () => {
  const runDir = tmp()
  assert.throws(() => enrichCost({ runDir, recordFile: path.join(runDir, 'r.json') }), new RegExp(`^Error: no agent-\\*\\.jsonl transcripts under ${runDir}$`))
})

test('enrich-cost sums only agent-*.jsonl transcripts, warns per unreadable one in name order, and says nothing of a real cost', () => {
  const runDir = tmp()
  const recordFile = path.join(tmp(), 'r.json')
  fs.writeFileSync(recordFile, '{}')
  fs.writeFileSync(path.join(runDir, 'agent-1.jsonl'), usage(7))
  fs.writeFileSync(path.join(runDir, 'xagent-2.jsonl'), usage(100))
  fs.writeFileSync(path.join(runDir, 'agent-3.jsonl.bak'), usage(100))
  fs.mkdirSync(path.join(runDir, 'agent-b.jsonl'))
  fs.mkdirSync(path.join(runDir, 'agent-a.jsonl'))
  /** @type {any} */
  let res
  const lines = stderrOf(() => { res = enrichCost({ runDir, recordFile }) })
  assert.deepEqual([res.cost.output, res.cost.agents, res.cost.skipped], [7, 1, 2])
  assert.equal(lines.length, 2)
  assert.match(String(lines[0]), /^craft-log-run WARNING: skipped unreadable transcript agent-a\.jsonl: EISDIR/)
  assert.match(String(lines[1]), /^craft-log-run WARNING: skipped unreadable transcript agent-b\.jsonl: EISDIR/)
})

test('enrich-cost warns when transcripts summed to zero tokens', () => {
  const runDir = tmp()
  const recordFile = path.join(tmp(), 'r.json')
  fs.writeFileSync(recordFile, '{}')
  fs.writeFileSync(path.join(runDir, 'agent-1.jsonl'), usage(0))
  assert.deepEqual(stderrOf(() => enrichCost({ runDir, recordFile })), [
    'craft-log-run WARNING: 1 transcript(s) summed to zero tokens — a real run is never free; likely the transcript usage schema drifted (realm @nick/craft, node #98)',
  ])
})

test('the store README is written once and never overwritten', () => {
  const store = tmp()
  writeRecord({ kind: 'workflow', name: 'review' }, { store, project: store, now: NOW })
  assert.match(fs.readFileSync(path.join(store, 'README.md'), 'utf8'), /^# craft run records\n/)
  fs.writeFileSync(path.join(store, 'README.md'), 'mine')
  writeRecord({ kind: 'workflow', name: 'review' }, { store, project: store, now: new Date(NOW.getTime() + 1000) })
  assert.equal(fs.readFileSync(path.join(store, 'README.md'), 'utf8'), 'mine')
})
