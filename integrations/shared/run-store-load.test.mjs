// The store's records as match-external-findings-cli reads them: a missing store is none, a record that does not
// parse is named, and a store that cannot be listed is an error, never an empty store.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadRecords } from './run-store-load.mjs'

test('a missing store is none, and a record that does not parse is named beside the ones that do', () => {
  assert.equal(loadRecords(path.join(os.tmpdir(), 'craft-ar-no-such-store')), null)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-ar-'))
  try {
    fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ name: 'review' }))
    fs.writeFileSync(path.join(dir, 'b.json'), '{')
    fs.writeFileSync(path.join(dir, 'index.jsonl'), '{}\n')
    const got = loadRecords(dir)
    assert.ok(got)
    assert.deepEqual(got.records, [{ name: 'review' }])
    assert.deepEqual(
      got.unreadable.map(u => u.file),
      ['b.json'],
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a store that is not a directory is an error, never an empty store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-ar-file-'))
  try {
    const file = path.join(dir, 'runs')
    fs.writeFileSync(file, '')
    assert.throws(() => loadRecords(file), /ENOTDIR/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
