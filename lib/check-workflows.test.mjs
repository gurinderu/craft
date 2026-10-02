// The workflow gate's command, run in-process (realm @nick/craft, #172): a broken engine fails it, the
// real tree passes it, and `--fix` is the one argument it reads.
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
// A region whose body is not its source's text: the checker reads the source from this checkout's lib/.
const DRIFTED = '// >>> craft-inline lib/path-segments.mjs pathSegments\nfunction pathSegments() {}\n// <<< craft-inline\n'

test('the real workflows/ passes', async () => {
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

test('a drifted region fails read-only, and only --fix rewrites it', async () => {
  const root = tree({ ...MANIFEST, 'workflows/w.js': DRIFTED })
  const file = path.join(root, 'workflows', 'w.js')
  try {
    const checked = await run(['--other'], process.env, root)
    assert.equal(checked.exitCode, 1)
    assert.ok(checked.stderr.some(l => l.includes('drifted')))
    assert.equal(fs.readFileSync(file, 'utf8'), DRIFTED, 'without --fix nothing is written')

    await run(['--fix'], process.env, root)
    assert.notEqual(fs.readFileSync(file, 'utf8'), DRIFTED)
    const after = await run([], process.env, root)
    assert.ok(!after.stderr.some(l => l.includes('drifted')), after.stderr.join('\n'))
    assert.ok(after.stdout.some(l => /ok +1 inlined region/.test(l)))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
