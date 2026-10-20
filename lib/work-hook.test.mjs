import { afterAll, test } from 'vitest'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hookLogPath, readHookLog } from './hook-log.mjs'
import { SWITCH_ENV } from './role-hook.mjs'
import { PROMPT_TEXT, SUBAGENT_TEXT, promptKind, workHook } from './work-hook.mjs'
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

test('findings and PR-comment requests, in English and Russian, are the findings class', () => {
  for (const p of [
    'address the review findings on #42',
    'Work through the findings from the last run',
    'please fix the PR comments',
    'there are comments on the PR, handle them',
    'resolve review feedback',
    'Fix the review and push',
    'разбери находки ревью',
    'поправь замечания',
    'ответь на комментарии к PR',
    'посмотри комментарии к пулреквесту',
    'нужны фиксы по ревью',
    'пофикси по комментариям',
  ]) assert.equal(promptKind(p), 'findings', p)
})

test('review and PR requests, in English and Russian, are the review class', () => {
  for (const p of [
    'review this branch',
    'Can you do a code review?',
    'open a PR when done',
    'what about the pull request',
    'сделай ревью ветки',
    'отдай на ревьюера',
    'открой пулл-реквест',
    '/craft:review',
  ]) assert.equal(promptKind(p), 'review', p)
})

test('ordinary coding talk is no class', () => {
  for (const p of [
    'fix the failing test',
    'add comments to this function',
    'preview the page',
    'I reviewed the plan yesterday; now implement step 2',
    'print the PRODUCT table',
    'зафиксируй решение в графе',
    'фиксация версий в lockfile',
    'пофикси тест',
    'добавь комментарии в код',
    'замечательно, продолжай',
    'и пр.',
    '',
  ]) assert.equal(promptKind(p), null, p)
})

test('a background agent\'s result handed back as a prompt is not a request, whatever its words', () => {
  assert.equal(promptKind('<task-notification>\n<result>review findings: 3</result>\n</task-notification>'), null)
})

test('the texts: four imperative prompt lines, three subagent lines, naming the skills, memory verbs and off switch', () => {
  const lines = PROMPT_TEXT.split('\n')
  assert.equal(lines.length, 4)
  for (const name of ['craft:addressing-findings', 'craft:review', 'craft:develop', 'craft:memory', 'record-decision', 'record-rule', 'record-question', 'memory backend:', 'brief', 'main session', `${SWITCH_ENV}=0`]) {
    assert.ok(PROMPT_TEXT.includes(name), name)
  }
  assert.ok(lines.every(l => l.startsWith('craft: ')))
  const sub = SUBAGENT_TEXT.split('\n')
  assert.equal(sub.length, 3)
  for (const name of ['craft:addressing-findings', 'craft:memory', 'record-question', 'main session', `${SWITCH_ENV}=0`]) assert.ok(SUBAGENT_TEXT.includes(name), name)
})

/** @param {Record<string, unknown>} fields @returns {string} */
const input = fields => JSON.stringify(fields)

test('the prompt hook speaks once per session and class, in a repo that declares a role, and logs each decision', () => {
  const root = repo(true)
  /** @type {import('./hook-log.mjs').HookEntry[]} */
  const log = []
  const say = (/** @type {string} */ prompt, session = 's1') => {
    const r = workHook(input({ hook_event_name: 'UserPromptSubmit', cwd: root, session_id: session, prompt }), {}, os.tmpdir(), NOW, () => log)
    if (r.entry) log.push(r.entry)
    return r
  }
  const first = say('address the findings')
  assert.deepEqual(JSON.parse(first.stdout), { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: PROMPT_TEXT } })
  assert.deepEqual(first.entry, { ts: NOW.toISOString(), repo: root, source: '', event: 'UserPromptSubmit', session: 's1', spoke: true, found: ['.claude/agents/dev.md'], silent: null, kind: 'findings' })
  const again = say('more findings')
  assert.equal(again.stdout, '')
  assert.equal(again.entry?.silent, 'already-said')
  assert.notEqual(say('now review it').stdout, '', 'another class speaks')
  assert.notEqual(say('findings', 's2').stdout, '', 'another session speaks')
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
})

test('the hook script never fails, exits 0, and appends what it decided to the hook log', async () => {
  const home = tmp()
  const r = await run([], {}, () => { throw new Error('no stdin') }, home)
  assert.equal(r.exitCode, 0)
  assert.equal(readHookLog(hookLogPath(home)), null)
  const root = repo(true)
  const env = { PATH: process.env['PATH'] ?? '', HOME: home }
  const prompt = spawnSync(process.execPath, [HOOK], { input: input({ hook_event_name: 'UserPromptSubmit', cwd: root, session_id: 's', prompt: 'ревью, пожалуйста' }), encoding: 'utf8', env })
  assert.equal(prompt.status, 0)
  assert.match(prompt.stdout, /craft:addressing-findings/)
  const sub = spawnSync(process.execPath, [HOOK], { input: input({ hook_event_name: 'SubagentStart', cwd: root, session_id: 's', agent_type: 'general-purpose' }), encoding: 'utf8', env })
  assert.match(sub.stdout, /SubagentStart/)
  assert.deepEqual(readHookLog(hookLogPath(home))?.map(e => [e.event, e.spoke]), [['UserPromptSubmit', true], ['SubagentStart', true]])
  const unwritable = path.join(tmp(), 'file')
  fs.writeFileSync(unwritable, '')
  const broken = spawnSync(process.execPath, [HOOK], { input: input({ hook_event_name: 'UserPromptSubmit', cwd: '/nonexistent/x', prompt: 'review' }), encoding: 'utf8', env: { HOME: unwritable } })
  assert.equal(broken.status, 0)
  assert.equal(broken.stderr, '')
})
