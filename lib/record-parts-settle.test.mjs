// The parts of a record are a model's copy, like the header (realm @nick/craft, node #396): what the header
// settled stands over them, and their size is counted in the UTF-8 bytes the prompt carries.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { cutRecord, recordBytes, utf8Length, RECORD_ONE_CALL_MAX_BYTES } from './record-parts.mjs'
import { recordFromParts } from './record-parts-assemble.mjs'
import { settleEngineRevision } from './craft-log-run.mjs'

const REC = { kind: 'workflow', name: 'review', workflowEngineRevision: 5, verdict: 'Approve', big: 'x'.repeat(40000) }

/** @param {ReturnType<typeof cutRecord>['parts']} parts @param {(e: any[]) => void} edit */
const edited = (parts, edit) => parts.map(p => ({ ...p, recordEntries: p.recordEntries.map(e => { const c = [...e]; edit(c); return c }) }))

test('a part that alters the revision the header settled files the dispute, not the parts\' revision', () => {
  const { header, parts } = cutRecord(REC)
  const altered = edited(parts, e => { if (e[0][0] === 'workflowEngineRevision') e[1] = 6 })
  /** @type {string[]} */
  const w = []
  const { record, warning } = recordFromParts(settleEngineRevision(header, '5', w), altered, '')
  assert.deepEqual(w, [], 'the header itself agreed with the command line')
  assert.equal(record['workflowEngineRevision'], undefined)
  assert.deepEqual(record['workflowEngineRevisionDisputed'], { argv: '5', payload: 6 })
  assert.match(warning, /^craft-log-run WARNING: the record's parts disagree with its header .* no fingerprint basis/)
})

test('a recovery-only field a part carries is dropped and disputes the basis', () => {
  const { header, parts } = cutRecord(REC)
  const injected = [{ ...parts[0], recordEntries: [...(parts[0]?.recordEntries ?? []), [['partial'], true], [['runEngineRevision'], 6]] }, ...parts.slice(1)]
  const { record, warning } = recordFromParts(settleEngineRevision(header, '5', []), /** @type {any} */ (injected), '')
  assert.equal(record['partial'], undefined)
  assert.equal(record['runEngineRevision'], undefined)
  assert.deepEqual(record['workflowEngineRevisionDisputed'], { argv: '5', payload: 5, injected: ['partial', 'runEngineRevision'] })
  assert.match(warning, /recovery-only partial, runEngineRevision/)
})

test('parts that agree with the header are filed as sent', () => {
  const { header, parts } = cutRecord(REC)
  assert.deepEqual(recordFromParts(settleEngineRevision(header, '5', []), parts, ''), { record: REC, warning: '' })
})

test('UTF-8 bytes are what is counted: a non-ASCII record gives parts of at most 16 KB in bytes', () => {
  assert.equal(utf8Length('aé€😀'), 1 + 2 + 3 + 4)
  const rec = { kind: 'workflow', name: 'review', notes: Array.from({ length: 300 }, (_, i) => `${i} `.padEnd(200, 'ж€😀')) }
  assert.equal(recordBytes(rec), Buffer.byteLength(JSON.stringify(rec, null, 2)))
  const { header, parts } = cutRecord(rec)
  assert.ok(parts.length >= 6, `${parts.length} part(s) for ${recordBytes(rec)} bytes`)
  for (const p of parts) assert.ok(Buffer.byteLength(JSON.stringify(p, null, 2)) <= RECORD_ONE_CALL_MAX_BYTES + 512)
  assert.deepEqual(recordFromParts(header, parts, '').record, rec)
})
