import { afterAll, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { workHook } from './work-hook.mjs'
import { CODEX_OTHER_LANGUAGE_TEXT, FINDINGS_TEXT, OTHER_LANGUAGE_TEXT, REVIEW_TEXT, coveredBy, nudgeText, workText } from './work-hook-text.mjs'
import { OPENCODE_FINDINGS_TEXT, OPENCODE_OTHER_LANGUAGE_TEXT, opencodeMessage } from './work-hook-opencode.mjs'

const NOW = new Date('2026-10-20T12:00:00Z')
// Greek "fix the comments", from code points: the hook's sources carry English only.
const GREEK = String.fromCodePoint(0x3b4, 0x3b9, 0x3cc, 0x3c1, 0x3b8, 0x3c9, 0x3c3, 0x3b5, 0x20, 0x3c4, 0x3b1, 0x20, 0x3c3, 0x3c7, 0x3cc, 0x3bb, 0x3b9, 0x3b1)
/** @typedef {import('./hook-log.mjs').HookEntry} HookEntry */

/** @type {string[]} */
const made = []
afterAll(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }) })

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

/** @param {string} root @param {HookEntry[]} log @param {Record<string, unknown>} [extra] */
const asker = (root, log, extra = {}) => (/** @type {string} */ prompt, session = 'new') => {
  const r = workHook(JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: root, session_id: session, prompt, ...extra }), {}, os.tmpdir(), NOW, () => log)
  if (r.entry) log.push(r.entry)
  return r
}
/** @param {{ stdout: string }} r @returns {unknown} */
const said = r => JSON.parse(r.stdout).hookSpecificOutput.additionalContext

test('a prompt in another script hears the conditional text once; it and the per-kind texts cover each other per session', () => {
  const ask = asker(repo(true), [])
  const first = ask(GREEK)
  assert.equal(said(first), OTHER_LANGUAGE_TEXT)
  assert.equal(first.entry?.kind, 'other-language')
  assert.equal(ask(GREEK).entry?.silent, 'already-said')
  assert.equal(ask('address the findings').entry?.silent, 'already-said', 'the conditional text covered findings')
  assert.equal(ask('review this branch').entry?.silent, 'already-said', 'and review')
  assert.equal(said(ask('review this branch', 's2')), REVIEW_TEXT)
  assert.equal(ask(GREEK, 's2').entry?.silent, 'already-said', 'any text said covers the conditional one')
  assert.deepEqual(coveredBy('claude-code', 'findings'), ['findings', 'other-language'])
  assert.equal(coveredBy('claude-code', 'other-language'), undefined)
  assert.equal(coveredBy('codex', 'review'), undefined)
  const codex = asker(repo(true), [], { turn_id: 't1' })(GREEK)
  assert.equal(said(codex), CODEX_OTHER_LANGUAGE_TEXT)
})

test('the conditional texts: six lines or fewer, English only, each kind\'s call under its condition, in each harness\'s words', () => {
  for (const text of [OTHER_LANGUAGE_TEXT, CODEX_OTHER_LANGUAGE_TEXT, OPENCODE_OTHER_LANGUAGE_TEXT]) {
    assert.ok(text.split('\n').length <= 6, text)
    assert.ok(text.split('\n').every(l => l.startsWith('craft: ')))
    assert.match(text, /^craft: if this request — in any language — asks to work review findings or PR comments \(triage, replies, fixes\), before your first tool call [^;]*addressing-findings[^;]*; if it asks for a review, .*Otherwise ignore these lines\.$/m)
    assert.doesNotMatch(text, /[^\x20-\x7e\n—→]/u)
  }
  assert.match(OTHER_LANGUAGE_TEXT, /Skill\("craft:addressing-findings"\); if it asks for a review, make one call here in the main session: Skill\("craft:develop"\)/)
  assert.match(CODEX_OTHER_LANGUAGE_TEXT, /SKILL\.md/)
  assert.doesNotMatch(CODEX_OTHER_LANGUAGE_TEXT, /Skill\(|Workflow/)
  assert.doesNotMatch(OPENCODE_OTHER_LANGUAGE_TEXT, /craft:develop|Skill\(|Workflow/)
  assert.equal(workText('claude-code', 'other-language').prompt, OTHER_LANGUAGE_TEXT)
})

test('OpenCode: a prompt in another script hears its conditional text, which then covers the per-kind ones', () => {
  const cwd = repo(true)
  /** @type {HookEntry[]} */
  const log = []
  const say = (/** @type {string} */ prompt, session = 's1') => {
    const r = opencodeMessage({ prompt, session, cwd }, {}, NOW, () => log)
    if (r.entry) log.push(r.entry)
    return r
  }
  assert.equal(say(GREEK).text, OPENCODE_OTHER_LANGUAGE_TEXT)
  assert.equal(say('address the findings').entry?.silent, 'already-said')
  assert.equal(say('address the findings', 's2').text, OPENCODE_FINDINGS_TEXT)
  assert.equal(say(GREEK, 's2').entry?.silent, 'already-said')
})

const HANDBACK = 'Another Claude session sent a message:\n<agent-message from="a627e0ee592a02009">\nFixed 3 PR comments and pushed.\n</agent-message>'

test('an agent\'s words are a logged silence; a bare English continuation takes this session\'s kind, or another session\'s for its first prompt', () => {
  const root = repo(true)
  const handback = asker(root, [])(HANDBACK)
  assert.equal(handback.stdout, '')
  assert.deepEqual([handback.entry?.spoke, handback.entry?.silent, handback.entry?.kind], [false, 'not-human', undefined])
  assert.equal(asker(root, [])('<task-notification>\n<result>review the PR</result>\n</task-notification>').entry?.silent, 'not-human')
  assert.equal(asker(repo(false), [])('<task-notification>\nreview\n</task-notification>').entry, null, 'a silent repo logs nothing')
  /** @param {string} ts @param {string} [where] @returns {HookEntry} */
  const line = (ts, where = root) => ({ ts, repo: where, source: '', event: 'UserPromptSubmit', session: 'old', kind: 'findings', spoke: true, found: [], silent: null })
  const first = asker(root, [line('2026-10-20T03:00:00.000Z')])('keep going please')
  assert.equal(said(first), FINDINGS_TEXT, 'the first prompt of a session after a restart')
  assert.equal(first.entry?.kind, 'findings')
  assert.equal(asker(root, [line('2026-10-19T23:00:00.000Z')])('keep going please').entry?.silent, 'no-kind', 'older than 12 hours')
  assert.equal(asker(root, [line('2026-10-20T11:00:00.000Z', '/elsewhere')])('keep going please').entry?.silent, 'no-kind', 'another repo')
  const ask = asker(root, [line('2026-10-20T11:00:00.000Z')])
  assert.equal(ask('implement the parser').entry?.silent, 'no-kind')
  assert.equal(ask('go ahead').entry?.kind, undefined, 'this session asked for something unclassed: the other session\'s kind does not reach it')
})

test('after a compact, a bare continuation keeps the session\'s request and hears its lines again', () => {
  const root = repo(true)
  const log = /** @type {HookEntry[]} */ ([])
  const mine = asker(root, log)
  assert.equal(said(mine('address the findings')), FINDINGS_TEXT)
  log.push({ ts: NOW.toISOString(), repo: root, source: 'compact', event: 'SessionStart', session: 'new', spoke: true, found: [], silent: null })
  const resumed = mine('continue')
  assert.equal(resumed.entry?.kind, 'findings', 'a compact does not drop the request')
  assert.equal(said(resumed), FINDINGS_TEXT, 'and its lines, gone with the compact, are said again')
})

test('a subagent\'s report after the findings text gets one conditional re-review line per session context; task notifications stay silent', () => {
  const log = /** @type {HookEntry[]} */ ([])
  const ask = asker(repo(true), log)
  assert.equal(ask(HANDBACK).entry?.silent, 'not-human', 'no findings text said in the session yet')
  ask('address the review findings')
  const first = ask(HANDBACK)
  assert.equal(said(first), nudgeText('claude-code'))
  const nudged = first.entry
  assert.ok(nudged)
  assert.deepEqual([nudged.spoke, nudged.silent, nudged.reason, nudged.kind], [true, null, 're-review-nudge', undefined])
  assert.equal(ask(HANDBACK).entry?.silent, 'not-human', 'once per session')
  assert.equal(ask('<task-notification>\n<result>fixed</result>\n</task-notification>').entry?.silent, 'not-human')
  assert.equal(ask('address the findings').entry?.silent, 'already-said', 'the nudge did not reset the findings text')
  log.push({ ts: NOW.toISOString(), repo: nudged.repo, source: 'compact', event: 'SessionStart', session: 'new', spoke: true, found: [], silent: null })
  ask('address the findings')
  assert.equal(said(ask(HANDBACK)), nudgeText('claude-code'), 'again after a compact')
  const other = asker(repo(true), [])
  other(GREEK)
  assert.equal(said(other(HANDBACK)), nudgeText('claude-code'), 'after the conditional text too')
  assert.equal(other(HANDBACK).entry?.silent, 'not-human')
})
