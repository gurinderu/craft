import { afterAll, test } from 'vitest'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hookLogPath, readHookLog } from './hook-log.mjs'
import { SWITCH_ENV } from './role-hook.mjs'
import { workHook } from './work-hook.mjs'
import { saidInSession } from './work-hook-said.mjs'
import { CODEX_PROMPT_TEXT, CODEX_SUBAGENT_TEXT, FINDINGS_TEXT, REVIEW_TEXT, SUBAGENT_TEXT } from './work-hook-text.mjs'
import { run } from './work-hook-entry.mjs'

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'work-hook-entry.mjs')
const NOW = new Date('2026-10-20T12:00:00Z')

/** @type {string[]} */
const made = []
afterAll(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }) })

/** @returns {string} */
function tmp() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-work-hook-')))
  made.push(dir)
  return dir
}

/** A throwaway repo; `declared` gives it a project agent. @param {boolean} declared @returns {string} */
function repo(declared) {
  const root = tmp()
  fs.mkdirSync(path.join(root, '.git'))
  if (declared) {
    fs.mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true })
    fs.writeFileSync(path.join(root, '.claude', 'agents', 'dev.md'), '')
  }
  return root
}

/** @param {Record<string, unknown>} fields @returns {string} */
const input = fields => JSON.stringify(fields)

test('the prompt hook speaks the text of the request\'s class, once per class and session, in a repo that declares a role, and logs each decision', () => {
  const root = repo(true)
  /** @type {import('./hook-log.mjs').HookEntry[]} */
  const log = []
  const say = (/** @type {string} */ prompt, session = 's1') => {
    const r = workHook(input({ hook_event_name: 'UserPromptSubmit', cwd: root, session_id: session, prompt }), {}, os.tmpdir(), NOW, () => log)
    if (r.entry) log.push(r.entry)
    return r
  }
  /** @param {{ stdout: string }} r @returns {unknown} */
  const said = r => JSON.parse(r.stdout).hookSpecificOutput.additionalContext
  const first = say('address the findings')
  assert.deepEqual(JSON.parse(first.stdout), { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: FINDINGS_TEXT } })
  assert.deepEqual(first.entry, { ts: NOW.toISOString(), repo: root, source: '', event: 'UserPromptSubmit', harness: 'claude-code', session: 's1', spoke: true, found: ['.claude/agents/dev.md'], silent: null, kind: 'findings' })
  const again = say('more findings')
  assert.equal(again.stdout, '')
  assert.equal(again.entry?.silent, 'already-said')
  assert.equal(said(say('now review it')), REVIEW_TEXT, 'the other class speaks its own text')
  assert.equal(say('review this branch').entry?.silent, 'already-said')
  assert.equal(said(say('findings', 's2')), FINDINGS_TEXT, 'another session speaks')
  log.push({ ts: NOW.toISOString(), repo: root, source: 'compact', event: 'SessionStart', session: 's1', spoke: true, found: [], silent: null })
  assert.equal(said(say('review again')), REVIEW_TEXT, 'a compact emptied the context: it speaks again')
  assert.equal(said(say('and the findings')), FINDINGS_TEXT)
  assert.equal(say('more findings').entry?.silent, 'already-said')
  const plain = say('write the parser')
  assert.deepEqual(plain, { stdout: '', entry: null }, 'a prompt of no class is not logged')
})

test('the prompt hook is silent where the start hook is: nothing declared, or switched off', () => {
  const none = workHook(input({ hook_event_name: 'UserPromptSubmit', cwd: repo(false), session_id: 's', prompt: 'review' }), {}, os.tmpdir(), NOW, () => [])
  assert.equal(none.stdout, '')
  assert.equal(none.entry?.silent, 'nothing-declared')
  const off = workHook(input({ hook_event_name: 'UserPromptSubmit', cwd: repo(true), session_id: 's', prompt: 'review' }), { [SWITCH_ENV]: '0' }, os.tmpdir(), NOW, () => [])
  assert.equal(off.entry?.silent, 'off-env')
  assert.deepEqual(workHook('not json', {}, os.tmpdir(), NOW, () => []), { stdout: '', entry: null })
  assert.deepEqual(workHook(input({ hook_event_name: 'Stop' }), {}, os.tmpdir(), NOW, () => []), { stdout: '', entry: null })
})

test('the subagent hook speaks to a subagent of a session where the prompt hook spoke, never to an engine agent', () => {
  const root = repo(true)
  /** @type {import('./hook-log.mjs').HookEntry} */
  const spoke = { ts: NOW.toISOString(), repo: root, source: '', event: 'UserPromptSubmit', session: 's1', kind: 'review', spoke: true, found: [], silent: null }
  const start = (/** @type {string} */ session, agent = 'general-purpose', logged = [spoke]) =>
    workHook(input({ hook_event_name: 'SubagentStart', cwd: root, session_id: session, agent_type: agent }), {}, os.tmpdir(), NOW, () => logged)
  const told = start('s1')
  assert.deepEqual(JSON.parse(told.stdout), { hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: SUBAGENT_TEXT } })
  assert.equal(told.entry?.event, 'SubagentStart')
  assert.equal(told.entry?.agent, 'general-purpose')
  assert.deepEqual(start('s2'), { stdout: '', entry: null }, 'no prompt hook spoke in that session')
  assert.deepEqual(start('s1', 'workflow-subagent'), { stdout: '', entry: null })
  assert.deepEqual(start('s1', 'general-purpose', [{ ...spoke, spoke: false, silent: 'already-said' }]), { stdout: '', entry: null })
  assert.deepEqual(start(''), { stdout: '', entry: null })
  const unread = workHook(input({ hook_event_name: 'SubagentStart', cwd: repo(false), session_id: 's1', agent_type: 'general-purpose' }), {}, os.tmpdir(), NOW, () => { throw new Error('log read') })
  assert.deepEqual(unread, { stdout: '', entry: null }, 'a silent repo is decided before the log is read')
})

test('lines said in a session stay said until a compact or clear SessionStart of that session', () => {
  /** @param {Partial<import('./hook-log.mjs').HookEntry>} x @returns {import('./hook-log.mjs').HookEntry} */
  const e = x => ({ ts: '', repo: '/r', source: '', spoke: true, found: [], silent: null, session: 's', ...x })
  const said = e({ event: 'UserPromptSubmit' })
  assert.equal(saidInSession([said], 's'), true)
  assert.equal(saidInSession([said], 'other'), false)
  assert.equal(saidInSession([said, e({ source: 'compact' })], 's'), false)
  assert.equal(saidInSession([said, e({ event: 'SessionStart', source: 'clear' })], 's'), false)
  assert.equal(saidInSession([said, e({ event: 'SessionStart', source: 'startup' })], 's'), true)
  assert.equal(saidInSession([e({ source: 'compact' }), said], 's'), true)
  assert.equal(saidInSession([e({ event: 'UserPromptSubmit', spoke: false, silent: 'already-said' })], 's'), false)
  const review = e({ event: 'UserPromptSubmit', kind: 'review' })
  assert.equal(saidInSession([review], 's', ['review']), true)
  assert.equal(saidInSession([review], 's', ['findings']), false, 'with a kind, only lines said for it count')
  assert.equal(saidInSession([review], 's'), true)
})

test('the hook script never fails, exits 0, and appends what it decided to the hook log', async () => {
  const home = tmp()
  const r = await run([], {}, () => { throw new Error('no stdin') }, home)
  assert.equal(r.exitCode, 0)
  assert.equal(readHookLog(hookLogPath(home)), null)
  const root = repo(true)
  const env = { PATH: process.env['PATH'] ?? '', HOME: home }
  const prompt = spawnSync(process.execPath, [HOOK], { input: input({ hook_event_name: 'UserPromptSubmit', cwd: root, session_id: 's', prompt: 'review, please' }), encoding: 'utf8', env })
  assert.equal(prompt.status, 0)
  assert.match(prompt.stdout, /craft:develop/)
  const sub = spawnSync(process.execPath, [HOOK], { input: input({ hook_event_name: 'SubagentStart', cwd: root, session_id: 's', agent_type: 'general-purpose' }), encoding: 'utf8', env })
  assert.match(sub.stdout, /SubagentStart/)
  assert.deepEqual(readHookLog(hookLogPath(home))?.map(e => [e.event, e.spoke]), [['UserPromptSubmit', true], ['SubagentStart', true]])
  const unwritable = path.join(tmp(), 'file')
  fs.writeFileSync(unwritable, '')
  const broken = spawnSync(process.execPath, [HOOK], { input: input({ hook_event_name: 'UserPromptSubmit', cwd: '/nonexistent/x', prompt: 'review' }), encoding: 'utf8', env: { HOME: unwritable } })
  assert.equal(broken.status, 0)
  assert.equal(broken.stderr, '')
})

test('under Codex the hooks speak Codex\'s words and log the harness', () => {
  const root = repo(true)
  /** @type {import('./hook-log.mjs').HookEntry[]} */
  const log = []
  const said = workHook(input({ hook_event_name: 'UserPromptSubmit', cwd: root, session_id: 'c1', turn_id: 't1', prompt: 'address the findings' }), {}, os.tmpdir(), NOW, () => log)
  assert.equal(JSON.parse(said.stdout).hookSpecificOutput.additionalContext, CODEX_PROMPT_TEXT)
  assert.equal(said.entry?.harness, 'codex')
  if (said.entry) log.push(said.entry)
  const other = workHook(input({ hook_event_name: 'UserPromptSubmit', cwd: root, session_id: 'c1', turn_id: 't3', prompt: 'review this branch' }), {}, os.tmpdir(), NOW, () => log)
  assert.equal(other.entry?.silent, 'already-said', 'Codex\'s one text names both classes: once per session')
  const sub = workHook(input({ hook_event_name: 'SubagentStart', cwd: root, session_id: 'c1', turn_id: 't2', agent_id: 'a1', agent_type: 'worker' }), {}, os.tmpdir(), NOW, () => log)
  assert.equal(JSON.parse(sub.stdout).hookSpecificOutput.additionalContext, CODEX_SUBAGENT_TEXT)
  assert.equal(sub.entry?.harness, 'codex')
})
