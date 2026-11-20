// The OpenCode work hook on a prompt in another script (lib/work-hook-opencode.mjs); the Claude Code and Codex hooks'
// answers are the craft binary's, held by content/parity/hook-cases.json.
import { afterAll, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { coveredBy } from './work-hook-text.mjs'
import { OPENCODE_FINDINGS_TEXT, OPENCODE_OTHER_LANGUAGE_TEXT, OPENCODE_REMINDER_TEXT, opencodeMessage } from './work-hook-opencode.mjs'

const NOW = new Date('2026-10-20T12:00:00Z')
// Greek "fix the comments", from code points: the hook's sources carry English only.
const GREEK = String.fromCodePoint(0x3b4, 0x3b9, 0x3cc, 0x3c1, 0x3b8, 0x3c9, 0x3c3, 0x3b5, 0x20, 0x3c4, 0x3b1, 0x20, 0x3c3, 0x3c7, 0x3cc, 0x3bb, 0x3b9, 0x3b1)
/** @typedef {import('./hook-log.mjs').HookEntry} HookEntry */

/** @type {string[]} */
const made = []
afterAll(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true })
})

/** A throwaway repo; `declared` gives it a project agent. @param {boolean} declared @returns {string} */
function repo(declared) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-lang-hook-')))
  made.push(root)
  fs.mkdirSync(path.join(root, '.git'))
  if (declared) {
    fs.mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true })
    fs.writeFileSync(path.join(root, '.claude', 'agents', 'dev.md'), '')
  }
  return root
}

test("the conditional text: six lines or fewer, English only, each kind's call under its condition, in OpenCode's words", () => {
  const text = OPENCODE_OTHER_LANGUAGE_TEXT
  assert.ok(text.split('\n').length <= 6, text)
  assert.ok(text.split('\n').every(l => l.startsWith('craft: ')))
  assert.match(
    text,
    /^craft: if this or any later request in this session — in any language — asks to work review findings or PR comments \(triage, replies, fixes\), before your first tool call [^;]*addressing-findings[^;]*; if it asks for a review, .*These lines apply only to such requests\.$/m,
  )
  assert.doesNotMatch(text, /[^\x20-\x7e\n—→]/u)
  assert.doesNotMatch(text, /craft:develop|Skill\(|Workflow/)
  assert.deepEqual(coveredBy('opencode', 'findings'), ['findings'])
  assert.deepEqual(coveredBy('opencode', 'other-language'), ['other-language'])
  assert.deepEqual(coveredBy('codex', 'review'), ['findings', 'review'])
})

test('OpenCode: a prompt in another script hears its conditional text, then its reminder; per-kind texts stay apart', () => {
  const cwd = repo(true)
  /** @type {HookEntry[]} */
  const log = []
  const say = (/** @type {string} */ prompt, session = 's1') => {
    const r = opencodeMessage({ prompt, session, cwd }, {}, NOW, () => log)
    if (r.entry) log.push(r.entry)
    return r
  }
  assert.equal(say(GREEK).text, OPENCODE_OTHER_LANGUAGE_TEXT)
  const again = say(GREEK)
  assert.equal(again.text, OPENCODE_REMINDER_TEXT)
  assert.deepEqual([again.entry?.reason, again.entry?.kind], ['language-reminder', undefined])
  assert.equal(say('address the findings').text, OPENCODE_FINDINGS_TEXT)
  assert.equal(say('address the findings').entry?.silent, 'already-said')
  assert.equal(say('address the findings', 's2').text, OPENCODE_FINDINGS_TEXT)
  assert.equal(say(GREEK, 's2').text, OPENCODE_OTHER_LANGUAGE_TEXT)
})
