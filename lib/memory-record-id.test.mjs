// The engine's plain-JS sha256 against node:crypto, and the memory skill's id rule.
import crypto from 'node:crypto'
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { sha256Hex, memoryRecordId } from './memory-record-id.mjs'

const STRINGS = [
  '', 'a', 'abc', 'decision\nunwrap in parser is fine\nsrc/parse.rs',
  'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(63), 'a'.repeat(64), 'a'.repeat(65), 'x'.repeat(1000),
  'ошибка в разборе', 'naïve café — “quoted”', '日本語のタイトル', 'emoji 🦀 crab and 𝄞 clef', 'mixed\ttabs\r\nand lines',
  'lone \ud800 surrogate',
]

test('sha256Hex equals node:crypto on ASCII, block-boundary and non-ASCII UTF-8 strings', () => {
  for (const s of STRINGS) assert.equal(sha256Hex(s), crypto.createHash('sha256').update(s, 'utf8').digest('hex'), JSON.stringify(s))
})

test('memoryRecordId: the skill\'s example and its normalisation', () => {
  const want = crypto.createHash('sha256').update('decision\nunwrap in parser is fine\nsrc/parse.rs').digest('hex').slice(0, 10)
  assert.equal(memoryRecordId('decision', 'unwrap in parser is fine', 'src/parse.rs'), `decision-${want}`)
  assert.equal(memoryRecordId('decision', '  Unwrap  in\tParser IS fine ', './src/parse.rs'), `decision-${want}`)
  assert.equal(memoryRecordId('question', 'q', 'src/dir/'), memoryRecordId('question', 'q', 'src/dir'))
  assert.match(memoryRecordId('question', 'q', '.'), /^question-[0-9a-f]{10}$/)
})
