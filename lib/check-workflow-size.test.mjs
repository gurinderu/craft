import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CEILING, HARNESS_LIMIT, run, sizeProblems } from './check-workflow-size.mjs'

test('the ceiling sits below the harness limit', () => {
  assert.equal(HARNESS_LIMIT, 524288)
  assert.equal(CEILING, 512000)
})

test('sizeProblems: at the ceiling passes, one byte over fails, naming the file, its size and the harness limit', () => {
  assert.deepEqual(sizeProblems([{ name: 'a.js', bytes: CEILING }]), [])
  assert.deepEqual(sizeProblems([{ name: 'a.js', bytes: 10 }, { name: 'b.js', bytes: CEILING + 1 }]), [
    'workflows/b.js is 512001 bytes, over the 512000-byte ceiling (the harness does not register a workflow script over 524288 bytes)',
  ])
})

/** @param {Record<string, number>} files */
function checkout(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-size-'))
  fs.mkdirSync(path.join(root, 'workflows'))
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(root, 'workflows', name), 'x'.repeat(bytes))
  return root
}

test('run: exit 1 on a script over the ceiling, 0 when all fit, 1 when there are none', async () => {
  const big = await run([], {}, checkout({ 'a.js': 3, 'b.js': CEILING + 1, 'notes.md': CEILING + 1 }))
  assert.equal(big.exitCode, 1)
  assert.deepEqual(big.stdout, [`ok    workflows/a.js 3 bytes (${CEILING - 3} under the ceiling)`])
  assert.equal(big.stderr.length, 1)
  assert.match(/** @type {string} */ (big.stderr[0]), /^FAIL {2}workflows\/b\.js is 512001 bytes/)
  assert.equal((await run([], {}, checkout({ 'a.js': CEILING }))).exitCode, 0)
  assert.equal((await run([], {}, checkout({}))).exitCode, 1)
})

test('run: the shipped workflows fit', async () => {
  const r = await run([], {})
  assert.deepEqual(r.stderr, [])
  assert.equal(r.exitCode, 0)
})
