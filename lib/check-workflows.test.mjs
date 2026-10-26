// The workflow gate's command, run in-process (realm @nick/craft, #172): a broken engine fails it, and the
// real tree passes it.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run } from './check-workflows.mjs'

/** @param {Record<string, string>} files @returns {string} */
function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-cw-'))
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), body)
  }
  return root
}

const MANIFEST = { '.claude-plugin/plugin.json': JSON.stringify({ version: '1.0.0' }) }
// Stryker rewrites lib/ in place while it runs: the real tree's checks then read mutated lib/ code.
const UNDER_STRYKER = process.env['STRYKER_MUTATOR_WORKER'] !== undefined

test.skipIf(UNDER_STRYKER)('the real workflows/ and src/ pass', async () => {
  const r = await run([], process.env)
  assert.equal(r.exitCode, 0, r.stderr.join('\n'))
  assert.deepEqual(r.stderr, [])
})

test('a workflow that does not parse fails the gate, and the failure names it', async () => {
  const root = tree({ ...MANIFEST, 'workflows/good.js': 'export const meta = {}\nreturn 1\n', 'workflows/bad.js': 'function (\n' })
  try {
    const r = await run([], process.env, root)
    assert.equal(r.exitCode, 1)
    assert.ok(r.stderr.some(l => l.includes('bad.js')), r.stderr.join('\n'))
    assert.ok(!r.stderr.some(l => l.includes('good.js')))
    assert.ok(r.stdout.some(l => l.includes('good.js')))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('an empty workflows/ fails as a misconfiguration, not as a pass', async () => {
  const root = tree({ ...MANIFEST, 'workflows/.keep': '' })
  try {
    const r = await run([], process.env, root)
    assert.equal(r.exitCode, 1)
    assert.ok(r.stderr.some(l => l.includes('workflows/')))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
