import { afterAll, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SWITCH_ENV } from './role-hook.mjs'
import { saidInSession } from './work-hook.mjs'
import { OPENCODE_PROMPT_TEXT, OPENCODE_SUBAGENT_TEXT, opencodeCompacted, opencodeMessage } from './work-hook-opencode.mjs'

const NOW = new Date('2026-10-21T12:00:00Z')
/** @type {string[]} */
const made = []
afterAll(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }) })

/** A throwaway repo; `declared` gives it a project agent. @param {boolean} declared @returns {string} */
function repo(declared) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-oc-hook-')))
  made.push(root)
  fs.mkdirSync(path.join(root, '.git'))
  if (declared) {
    fs.mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true })
    fs.writeFileSync(path.join(root, '.claude', 'agents', 'dev.md'), '')
  }
  return root
}

/** @typedef {import('./hook-log.mjs').HookEntry} HookEntry */

test('a main session hears the lines once per review request until a compaction, and each decision is logged', () => {
  const cwd = repo(true)
  /** @type {HookEntry[]} */
  const log = []
  const say = (/** @type {string} */ prompt, session = 's1') => {
    const r = opencodeMessage({ prompt, session, cwd }, {}, NOW, () => log)
    if (r.entry) log.push(r.entry)
    return r
  }
  const first = say('address the review findings')
  assert.equal(first.text, OPENCODE_PROMPT_TEXT)
  assert.deepEqual(first.entry, { ts: NOW.toISOString(), repo: cwd, source: '', event: 'chat.message', harness: 'opencode', session: 's1', spoke: true, found: ['.claude/agents/dev.md'], silent: null, kind: 'findings' })
  assert.equal(say('review it again').entry?.silent, 'already-said')
  assert.equal(say('сделай ревью', 's2').text, OPENCODE_PROMPT_TEXT, 'another session speaks')
  assert.deepEqual(say('write the parser'), { text: '', entry: null }, 'a prompt of no class is not logged')
  const reset = opencodeCompacted('s1', cwd, NOW, () => log)
  assert.deepEqual(reset && { event: reset.event, harness: reset.harness, session: reset.session, spoke: reset.spoke, silent: reset.silent }, { event: 'session.compacted', harness: 'opencode', session: 's1', spoke: false, silent: 'context-reset' })
  if (reset) log.push(reset)
  assert.equal(say('and the findings').text, OPENCODE_PROMPT_TEXT, 'the compaction emptied the context: it speaks again')
  assert.equal(opencodeCompacted('quiet', cwd, NOW, () => log), null, 'a session that heard nothing logs no compaction')
})

test('the lines name what the OpenCode delivery ships, not the Claude Code-only engines', () => {
  for (const text of [OPENCODE_PROMPT_TEXT, OPENCODE_SUBAGENT_TEXT]) {
    assert.match(text, /addressing-findings/)
    assert.doesNotMatch(text, /craft:develop|craft:review\b|craft:memory|Workflow|Skill tool/)
  }
})

test('the subagent line: a fixer loads addressing-findings, a reviewer only reports', () => {
  const [line] = OPENCODE_SUBAGENT_TEXT.split('\n')
  // A reviewer subagent is not sent into the fix loop: the review case has its own clause (realm @nick/craft, #288).
  assert.ok(/brief is to work review findings[^;]*addressing-findings/.test(line ?? ''), line)
  assert.ok(/brief is to review: report findings only, change no code/.test(line ?? ''), line)
})

test('silent where the start hook is: nothing declared, or switched off', () => {
  assert.equal(opencodeMessage({ prompt: 'review', session: 's', cwd: repo(false) }, {}, NOW, () => []).entry?.silent, 'nothing-declared')
  assert.equal(opencodeMessage({ prompt: 'review', session: 's', cwd: repo(true) }, { [SWITCH_ENV]: '0' }, NOW, () => []).entry?.silent, 'off-env')
  assert.deepEqual(opencodeMessage({ prompt: 'review', session: 'c', cwd: repo(false), parent: 'p', agent: 'general' }, {}, NOW, () => []), { text: '', entry: null })
})

test('a subagent hears its lines when its brief asks for review work or its parent heard the prompt lines', () => {
  const cwd = repo(true)
  /** @type {HookEntry} */
  const heard = { ts: NOW.toISOString(), repo: cwd, source: '', event: 'chat.message', session: 'p', spoke: true, found: [], silent: null, kind: 'review' }
  const brief = (/** @type {string} */ prompt, /** @type {HookEntry[]} */ log) => opencodeMessage({ prompt, session: 'c', cwd, parent: 'p', agent: 'general' }, {}, NOW, () => log)
  const byParent = brief('write the parser', [heard])
  assert.equal(byParent.text, OPENCODE_SUBAGENT_TEXT)
  assert.deepEqual(byParent.entry && { event: byParent.entry.event, session: byParent.entry.session, agent: byParent.entry.agent, kind: byParent.entry.kind }, { event: 'chat.message', session: 'p', agent: 'general', kind: undefined })
  assert.equal(brief('fix the PR comments', []).entry?.kind, 'findings', 'the brief itself names the work')
  assert.deepEqual(brief('write the parser', []), { text: '', entry: null })
  assert.deepEqual(brief('write the parser', [{ ...heard, agent: 'general' }]), { text: '', entry: null }, 'a subagent line is not the parent hearing')
})

test('saidInSession reads OpenCode lines: a main chat.message that spoke, reset by session.compacted', () => {
  /** @type {HookEntry} */
  const said = { ts: '', repo: '', source: '', event: 'chat.message', session: 's', spoke: true, found: [], silent: null }
  assert.equal(saidInSession([said], 's'), true)
  assert.equal(saidInSession([{ ...said, agent: 'general' }], 's'), false)
  assert.equal(saidInSession([said, { ...said, event: 'session.compacted', spoke: false }], 's'), false)
})
