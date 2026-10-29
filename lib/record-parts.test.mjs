// The final record cut into parts and put back (realm @nick/craft, node #396): the pure half.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { cutRecord, recordBytes, RECORD_ONE_CALL_MAX_BYTES } from './record-parts.mjs'
import { recordFromParts, isTransportSlice } from './record-parts-assemble.mjs'
import { payloadBytes } from './ledger-shards.mjs'

// A record well past 100 KB: long strings, nested arrays, one string larger than a part on its own.
const BIG = {
  schemaVersion: 1, kind: 'workflow', name: 'review', craftVersion: '9.9.9', round: 3, verdict: 'Warning', empty: [], none: null,
  findings: Array.from({ length: 140 }, (_, i) => ({ title: `t${i}`, file: `src/f${i % 7}.rs`, line: i, why: `${i} `.padEnd(700, 'w'), sources: ['a', 'b', { n: i }] })),
  dimensions: Array.from({ length: 30 }, (_, i) => ({ dimension: `p:l${i}`, bySeverity: { High: i, Low: 1 }, ran: i % 2 === 0 })),
  notes: 'é"\\\n'.repeat(9000),
  nested: { deep: { list: Array.from({ length: 50 }, (_, i) => `${i}`.padEnd(500, 'x')) } },
}

/** @param {ReturnType<typeof cutRecord>['parts']} parts */
const asPhases = parts => parts.map((p, i) => ({ phase: `${String(i).padStart(2, '0')}-record`, ...p }))

test('a record past 100 KB is cut into parts of at most 16 KB and put back exactly', () => {
  assert.ok(recordBytes(BIG) > 100 * 1024, `${recordBytes(BIG)} bytes`)
  const { header, parts } = cutRecord(BIG)
  assert.ok(parts.length >= 7, `${parts.length} part(s)`)
  for (const p of parts) {
    assert.ok(p.recordEntries.reduce((n, e) => n + payloadBytes(e), 0) <= RECORD_ONE_CALL_MAX_BYTES)
    assert.ok(recordBytes(p) <= RECORD_ONE_CALL_MAX_BYTES + 512, `${recordBytes(p)} bytes`)
  }
  assert.ok(recordBytes(header) < 2048, `header ${recordBytes(header)} bytes`)
  const { record, warning } = recordFromParts(header, asPhases(parts), '')
  assert.equal(warning, '')
  assert.deepEqual(record, BIG)
  assert.equal(JSON.stringify(record), JSON.stringify(BIG), 'key order too')
})

test('a record that fits one call is not cut, and finalize takes it as it came', () => {
  const small = { kind: 'workflow', name: 'triage-findings', verdict: 'ok' }
  const { header, parts } = cutRecord(small)
  assert.equal(parts.length, 0)
  assert.equal(header, small)
  assert.equal(recordFromParts(small, [], '').record, small)
})

test('a part sent twice is taken once', () => {
  const { header, parts } = cutRecord(BIG)
  const { record, warning } = recordFromParts(header, asPhases([...parts, ...parts.slice(2, 4)]), '')
  assert.equal(warning, '')
  assert.deepEqual(record, BIG)
})

test('a missing part files what the rest hold, loudly, with the declaration kept', () => {
  const { header, parts } = cutRecord(BIG)
  const { record, warning } = recordFromParts(header, asPhases(parts.filter((_, i) => i !== 1)), '')
  assert.match(warning, new RegExp(`declared in ${parts.length} part\\(s\\), ${parts.length - 1} found`))
  assert.deepEqual(record['recordInParts'], { ...(/** @type {object} */ (header['recordInParts'])), seen: parts.length - 1 })
  assert.equal(record['verdict'], 'Warning')
  assert.ok(Array.isArray(record['findings']) && record['findings'].every(f => f && typeof f === 'object'), 'no holes in an array')
  assert.ok(/** @type {unknown[]} */ (record['findings']).length < BIG.findings.length)
})

test('an unusable directory or another record\'s parts give the header alone, with a warning', () => {
  const { header, parts } = cutRecord(BIG)
  const gone = recordFromParts(header, asPhases(parts), 'the run directory was gone before finalize')
  assert.match(gone.warning, /but the run directory was gone before finalize/)
  assert.equal(gone.record['round'], 3)
  const other = cutRecord({ ...BIG, round: 4 })
  assert.match(recordFromParts(header, asPhases(other.parts), '').warning, /0 found/)
})

test('an entry of the wrong shape is not placed, and keys named __proto__, constructor or prototype stay keys', () => {
  const id = 'x'
  const header = { kind: 'workflow', recordInParts: { of: 1, id } }
  const part = { recordPart: { index: 1, of: 1, id }, recordEntries: [
    [['__proto__', 'polluted'], true], [['constructor', 'prototype', 'polluted'], true], [['prototype', 'polluted'], true],
    [['a'], 1], 'junk', [[], 2], [['b', -1], 3],
  ] }
  const { record, warning } = recordFromParts(header, [part], '')
  assert.equal(/** @type {any} */ ({}).polluted, undefined)
  assert.equal(/** @type {any} */ (Object.prototype).polluted, undefined)
  assert.equal(Object.getPrototypeOf(record), Object.prototype)
  assert.deepEqual(Object.keys(record), ['kind', '__proto__', 'constructor', 'prototype', 'a', 'recordInParts'])
  assert.deepEqual(JSON.parse(JSON.stringify(record['constructor'])), { prototype: { polluted: true } })
  const cut = cutRecord(JSON.parse(`{"kind":"workflow","__proto__":{"polluted":true},"big":"${'x'.repeat(40000)}"}`))
  assert.equal(Object.getPrototypeOf(cut.header), Object.prototype)
  assert.ok(Object.prototype.hasOwnProperty.call(cut.header, '__proto__'))
  assert.equal(record['a'], 1)
  assert.match(warning, /3 entr\(ies\) unreadable/)
})

test('the header\'s disputed revision stands over the one the parts carried', () => {
  const rec = { ...BIG, workflowEngineRevision: 7 }
  const { header, parts } = cutRecord(rec)
  /** @type {Record<string, unknown>} */
  const disputed = { ...header, workflowEngineRevisionDisputed: { argv: '8', payload: 7 } }
  delete disputed['workflowEngineRevision']
  const { record } = recordFromParts(disputed, asPhases(parts), '')
  assert.equal(record['workflowEngineRevision'], undefined)
  assert.deepEqual(record['workflowEngineRevisionDisputed'], { argv: '8', payload: 7 })
})

test('record parts and ledger shards are transport slices; a phase is not', () => {
  assert.equal(isTransportSlice({ recordPart: { index: 1 } }), true)
  assert.equal(isTransportSlice({ ledgerShard: { index: 1 } }), true)
  assert.equal(isTransportSlice({ phase: 'plan' }), false)
  assert.equal(isTransportSlice(null), false)
})
