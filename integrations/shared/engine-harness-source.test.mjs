// runEngine runs the engine built from integrations/claude-code/src/ and integrations/shared/ as they are now, not the committed workflows/ bundle: a
// changed integrations/shared/ module — an edit, or a mutant Stryker plants in place — changes what the engine tests execute.
// The tree is a temporary copy holding one probe engine and the integrations/shared/ module it imports, so the planted change
// touches nothing in the checkout.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runEngine, authoredText, STRYKER_TEMP_DIR } from './engine-harness.mjs'
import stryker from './config/stryker.config.mjs'

const ENGINE = `import { answer } from '../../shared/probe-answer.mjs'

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

test('runEngine runs the engine built from the integrations/shared/ modules on disk, rebuilt when one changes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-harness-'))
  try {
    put(root, 'integrations/claude-code/src/probe.js', ENGINE)
    put(root, 'integrations/shared/probe-answer.mjs', module('original'))
    // A committed bundle that no longer matches its sources: what runEngine must NOT run.
    put(root, 'integrations/claude-code/workflows/probe.js', "const meta = { name: 'probe' }\nreturn 'stale shipped bundle'\n")
    assert.equal((await runEngine('probe', { root })).report, 'original')
    put(root, 'integrations/shared/probe-answer.mjs', module('planted'))
    assert.equal((await runEngine('probe', { root })).report, 'planted', 'a changed integrations/shared/ module must change what runs')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// Stryker's in-place run rewrites each integrations/shared/ module it mutates and keeps the original in its temp directory, so a pin
// on a module's text reads the original there: the rewrite is the same text for every mutant, a pin on it measures
// none of them, and its wrappers break pins on the code's shape.
// The preamble follows the module's leading comments, on the line a JSDoc block ends.
const INSTRUMENTED = "// @ts-nocheck\n/** @returns {number} */function stryNS_9fa48() {\n  return 1\n}\nexport const x = stryMutAct_9fa48('0') ? 0 : 1\n"

test('authoredText reads a module as written, and an instrumented one from the backup Stryker keeps', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-authored-'))
  try {
    put(root, 'integrations/shared/plain.mjs', 'export const x = 1\n')
    assert.equal(authoredText('integrations/shared/plain.mjs', root), 'export const x = 1\n')
    put(root, 'integrations/shared/m.mjs', INSTRUMENTED)
    assert.throws(() => authoredText('integrations/shared/m.mjs', root), /integrations\/shared\/m\.mjs is instrumented by Stryker and no backup of it/)
    put(root, `${STRYKER_TEMP_DIR}/backup-old/integrations/shared/m.mjs`, 'export const x = 0\n')
    put(root, `${STRYKER_TEMP_DIR}/backup-new/integrations/shared/m.mjs`, 'export const x = 1\n')
    const past = new Date(Date.UTC(2020, 0, 1))
    fs.utimesSync(path.join(root, STRYKER_TEMP_DIR, 'backup-old'), past, past)
    assert.equal(authoredText('integrations/shared/m.mjs', root), 'export const x = 1\n', 'the newest backup holds the original of this run')
    put(root, 'integrations/claude-code/workflows/w.js', '// @ts-nocheck\nexport const meta = {}\n')
    assert.equal(
      authoredText('integrations/claude-code/workflows/w.js', root),
      '// @ts-nocheck\nexport const meta = {}\n',
      "a leading @ts-nocheck with no backup is the file's own",
    )
    put(root, `${STRYKER_TEMP_DIR}/backup-new/integrations/claude-code/workflows/w.js`, 'export const meta = {}\n')
    assert.equal(
      authoredText('integrations/claude-code/workflows/w.js', root),
      'export const meta = {}\n',
      "the line Stryker adds to every script is not the file's",
    )
    // A leading block comment stays first: Stryker puts its line after it, not at byte 0.
    const blockLed = '/* the module */\nexport const y = 2\n'
    put(root, 'integrations/shared/b.mjs', '/* the module */\n// @ts-nocheck\n\nexport const y = 2\n')
    put(root, `${STRYKER_TEMP_DIR}/backup-new/integrations/shared/b.mjs`, blockLed)
    assert.equal(authoredText('integrations/shared/b.mjs', root), blockLed, "the line Stryker adds after a leading block comment is not the file's")
    put(root, 'integrations/shared/own.mjs', '/* the module */\n// @ts-nocheck\nexport const y = 2\n')
    assert.equal(
      authoredText('integrations/shared/own.mjs', root),
      '/* the module */\n// @ts-nocheck\nexport const y = 2\n',
      "a @ts-nocheck of its own with no backup is the file's",
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the temp directory authoredText reads backups from is the one integrations/shared/config/stryker.config.mjs names', () => {
  assert.equal(STRYKER_TEMP_DIR, stryker.tempDirName)
  assert.equal(stryker.inPlace, true, 'the backup exists only for an in-place run')
})
