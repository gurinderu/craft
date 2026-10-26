// runEngine runs the engine built from src/ and lib/ as they are now, not the committed workflows/ bundle: a
// changed lib/ module — an edit, or a mutant Stryker plants in place — changes what the engine tests execute.
// The tree is a temporary copy holding one probe engine and the lib/ module it imports, so the planted change
// touches nothing in the checkout.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runEngine } from './engine-harness.mjs'

const ENGINE = `import { answer } from '../lib/probe-answer.mjs'

export const meta = {
  name: 'probe',
}
export async function __run() {
  return answer()
}
`

/** @param {string} value */
const module = value => `export function answer() {\n  return '${value}'\n}\n`

/** @param {string} root @param {string} rel @param {string} text */
const put = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), text)
}

test('runEngine runs the engine built from the lib/ modules on disk, rebuilt when one changes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-harness-'))
  try {
    put(root, 'src/probe.js', ENGINE)
    put(root, 'lib/probe-answer.mjs', module('original'))
    // A committed bundle that no longer matches its sources: what runEngine must NOT run.
    put(root, 'workflows/probe.js', "const meta = { name: 'probe' }\nreturn 'stale shipped bundle'\n")
    assert.equal((await runEngine('probe', { root })).report, 'original')
    put(root, 'lib/probe-answer.mjs', module('planted'))
    assert.equal((await runEngine('probe', { root })).report, 'planted', 'a changed lib/ module must change what runs')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
