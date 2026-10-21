import { afterAll, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { workHook } from './work-hook.mjs'
import { recentKind, saidInSession } from './work-hook-said.mjs'
import { CODEX_REMINDER_TEXT, FINDINGS_TEXT, OTHER_LANGUAGE_TEXT, REMINDER_TEXT, nudgeText } from './work-hook-text.mjs'
import { OPENCODE_REMINDER_TEXT } from './work-hook-opencode.mjs'
import { renderHookSection } from './hook-log.mjs'

const NOW = new Date('2026-10-21T12:00:00Z')
// Russian samples from code points (the sources carry English only): "hello", and "fix the review remarks".
const HELLO = String.fromCodePoint(0x43f, 0x440, 0x438, 0x432, 0x435, 0x442)
const FIX_REMARKS = String.fromCodePoint(0x438, 0x441, 0x43f, 0x440, 0x430, 0x432, 0x44c, 0x20, 0x437, 0x430, 0x43c, 0x435, 0x447, 0x430, 0x43d, 0x438, 0x44f)
/** @typedef {import('./hook-log.mjs').HookEntry} HookEntry */

/** @type {string[]} */
const made = []
afterAll(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }) })

/** A throwaway repo with a declared role. @returns {string} */
function repo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-reminder-')))
  made.push(root)
  fs.mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true })
  fs.mkdirSync(path.join(root, '.git'))
  fs.writeFileSync(path.join(root, '.claude', 'agents', 'dev.md'), '')
  return root
}

/** @param {string} root @param {HookEntry[]} log */
const asker = (root, log) => (/** @type {string} */ prompt) => {
  const r = workHook(JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: root, session_id: 's', prompt }), {}, os.tmpdir(), NOW, () => log)
  if (r.entry) log.push(r.entry)
  return r
}
/** @param {{ stdout: string }} r @returns {unknown} */
const said = r => JSON.parse(r.stdout).hookSpecificOutput.additionalContext
/** A prompt hook line. @param {Partial<HookEntry>} x @returns {HookEntry} */
const line = x => ({ ts: NOW.toISOString(), repo: '/r', source: '', event: 'UserPromptSubmit', session: 's', spoke: true, found: [], silent: null, ...x })

test('the review\'s sequence: a greeting in another script no longer silences the findings request or a later one', () => {
  const ask = asker(repo(), [])
  assert.equal(said(ask(HELLO)), OTHER_LANGUAGE_TEXT, 'the greeting hears the standing conditional text')
  const findings = ask('address the review findings on PR 12')
  assert.equal(said(findings), FINDINGS_TEXT)
  assert.equal(findings.entry?.kind, 'findings')
  const later = ask(FIX_REMARKS)
  assert.equal(said(later), REMINDER_TEXT, 'a later request in another script hears the reminder')
  assert.deepEqual([later.entry?.reason, later.entry?.kind], ['language-reminder', undefined])
  assert.equal(said(ask(FIX_REMARKS)), REMINDER_TEXT, 'and so does each one after it')
  assert.equal(ask('more findings').entry?.silent, 'already-said', 'the findings text stays once per context')
})

test('the reverse: after the English findings text, the first request in another script hears the conditional text', () => {
  const ask = asker(repo(), [])
  assert.equal(said(ask('address the review findings')), FINDINGS_TEXT)
  assert.equal(said(ask(FIX_REMARKS)), OTHER_LANGUAGE_TEXT)
  assert.equal(said(ask(FIX_REMARKS)), REMINDER_TEXT)
})

test('a compact or clear makes the next request in another script the first in its context again', () => {
  const log = /** @type {HookEntry[]} */ ([])
  const root = repo()
  const ask = asker(root, log)
  ask(HELLO)
  assert.equal(said(ask(HELLO)), REMINDER_TEXT)
  for (const source of ['compact', 'clear']) {
    log.push({ ...line({ source, event: 'SessionStart' }), repo: root })
    assert.equal(said(ask(FIX_REMARKS)), OTHER_LANGUAGE_TEXT, source)
    assert.equal(said(ask(FIX_REMARKS)), REMINDER_TEXT, source)
  }
})

test('the reminder is no request\'s text: the said check and a continuation\'s kind pass over it; the nudge still comes', () => {
  const reminder = line({ reason: 'language-reminder' })
  assert.equal(saidInSession([reminder], 's'), false)
  assert.equal(recentKind([line({ kind: 'findings' }), reminder], '/r', 's', NOW), 'findings')
  const ask = asker(repo(), [])
  ask(HELLO)
  ask(FIX_REMARKS)
  assert.equal(said(ask('Another Claude session sent a message:\n<agent-message from="a1">\nFixed and pushed.\n</agent-message>')), nudgeText('claude-code'))
})

test('the reminder lines: one line each, English only, in each harness\'s words', () => {
  for (const text of [REMINDER_TEXT, CODEX_REMINDER_TEXT, OPENCODE_REMINDER_TEXT]) {
    assert.equal(text.split('\n').length, 1)
    assert.match(text, /^craft: if this request is about review findings, PR comments or a review, the craft lines above apply: .*addressing-findings.* first for findings; .* for a review; recall memory before triage; before posting replies, run a light re-review of the fix commits only \(base: the commit the review was made on; a merge since it, as trunk merged in, means ask the human first\): .+\.$/)
    assert.doesNotMatch(text, /[^\x20-\x7e]/u)
  }
  assert.match(REMINDER_TEXT, /Skill\("craft:addressing-findings"\) first for findings; craft:develop or the review workflow for a review/)
  assert.match(REMINDER_TEXT, /: craft:review \{ base: <that commit>, fresh: true, fullEvery: 0 \} or craft:adversarial-review \{ diffBase: <that commit> \}\.$/)
  assert.match(CODEX_REMINDER_TEXT, /: your own review pass over them in this session\.$/)
  assert.match(OPENCODE_REMINDER_TEXT, /: the rust-review skill for Rust code, otherwise your own review pass over them in this session\.$/)
  assert.doesNotMatch(CODEX_REMINDER_TEXT, /Skill\(|Workflow|craft:develop/)
  assert.doesNotMatch(OPENCODE_REMINDER_TEXT, /Skill\(|Workflow|craft:develop/)
})

test('the hooks report shows the nudge and the reminder as rows of their own, apart from the request texts', () => {
  const lines = renderHookSection([
    line({ kind: 'other-language' }), line({ reason: 'language-reminder' }), line({ reason: 'language-reminder' }),
    line({ reason: 're-review-nudge' }), line({ spoke: false, silent: 'no-kind' }), line({ spoke: false, silent: 'not-human' }),
  ], [])
  assert.deepEqual(lines.slice(2, 5), [
    '- UserPromptSubmit: 3 run(s) — spoke 1, silent 2 (no-kind 1, not-human 1)',
    '- UserPromptSubmit language-reminder: 2 run(s) — spoke 2, silent 0',
    '- UserPromptSubmit re-review-nudge: 1 run(s) — spoke 1, silent 0',
  ])
})
