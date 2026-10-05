// The edges of the delivery-parity gate the main suite does not reach: what the body measurement
// strips and what it leaves, a malformed phrase, a quiet exemption, and how readAgents reads a directory.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EVIDENCE, checkContentParity, readAgents, requirementsReported } from './check-delivery-parity.mjs'

test('only a LEADING byte-order mark is dropped: one inside the body still breaks a phrase', () => {
  assert.deepEqual([...requirementsReported('﻿Evidence: yes', EVIDENCE)], ['field'])
  assert.deepEqual([...requirementsReported('intro Ev﻿idence: yes', EVIDENCE)], [])
})

test('only a frontmatter block that opens the body is stripped, not a --- pair further down', () => {
  assert.deepEqual([...requirementsReported('Evidence: yes\n---\na\n---\nrest', EVIDENCE)], ['field'])
  assert.deepEqual([...requirementsReported('---\ndescription: Evidence: x\n---\nbody', EVIDENCE)], [])
})

test('an absent body reaches nothing', () => {
  assert.deepEqual([...requirementsReported(undefined, { k: ['Stryker'] })], [])
})

test('a phrase that is not a string is a form problem, not a crash', () => {
  const body = new Map([['a', 'x']])
  // A hand-authoring slip the types would refuse, so it is cast in: the gate meets it at run time.
  const malformed = /** @type {Record<string, Record<string, string[]>>} */ (/** @type {unknown} */ ({ g: { k: [5] } }))
  const problems = checkContentParity(body, body, {}, malformed, {})
  assert.equal(problems.length, 1, problems.join('\n'))
  assert.match(problems[0] ?? '', /must list its phrases as a non-empty array of non-blank strings/)
})

test('an exemption on a group neither delivery reaches stays quiet', () => {
  const body = new Map([['a', 'nothing relevant']])
  assert.deepEqual(checkContentParity(body, body, {}, { g: { k: ['Alpha clause'] } }, { a: { g: 'lands later' } }), [])
})

test('readAgents reads only .md files, each body as written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-parity-md-'))
  try {
    fs.writeFileSync(path.join(dir, 'b.md'), 'body of b')
    fs.writeFileSync(path.join(dir, 'a.md'), 'body of a')
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not an agent')
    assert.deepEqual([...readAgents(dir)], [['a', 'body of a'], ['b', 'body of b']])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('readAgents keeps the read error as the cause of the one it throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-parity-cause-'))
  try {
    fs.mkdirSync(path.join(dir, 'oops.md'))
    assert.throws(() => readAgents(dir), (/** @type {Error} */ err) =>
      /** @type {NodeJS.ErrnoException | undefined} */ (err.cause)?.code === 'EISDIR')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
