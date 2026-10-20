import { afterAll, test } from 'vitest'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findRepoRoot, readDeclarations, roleHookText, sessionStartOutput, SWITCH_ENV } from './role-hook.mjs'
import { run } from './session-start-hook.mjs'

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'session-start-hook.mjs')

/** @type {string[]} */
const made = []
afterAll(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }) })

/** A fresh temporary directory, removed after the file. @returns {string} */
function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-role-hook-'))
  made.push(dir)
  return dir
}

/** A throwaway repo with the given files. @param {Record<string, string>} files @returns {string} */
function repo(files) {
  const root = tmp()
  fs.mkdirSync(path.join(root, '.git'))
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text)
  }
  return root
}

const RULES = '# Rules\nOpen a pull request after the review.\n'

test('silent when the repo declares nothing, or only describes its code', () => {
  assert.equal(roleHookText({ agents: [], rules: [] }, {}), '')
  assert.equal(roleHookText({ agents: [], rules: [{ path: 'CLAUDE.md', text: '# Build\nnpm test\n' }] }, {}), '')
})

test('a project agent or a rules file about how work lands makes it speak, naming what it found, in at most 6 lines', () => {
  const text = roleHookText({ agents: ['.claude/agents/dev.md'], rules: [{ path: 'AGENTS.md', text: RULES }] }, {})
  const lines = text.split('\n')
  assert.ok(lines.length >= 1 && lines.length <= 6, text)
  assert.match(lines[0] ?? '', /\(\.claude\/agents\/dev\.md, AGENTS\.md\); they win on every step they cover\.$/)
  assert.match(text, /craft:memory/)
  assert.match(text, /craft:develop/)
  assert.match(text, /subagent hands the review loop back to the main session/)
  assert.match(text, /CRAFT_ROLE_HOOK=0/)
  assert.match(roleHookText({ agents: [], rules: [{ path: 'CLAUDE.md', text: 'Each commit is conventional.' }] }, {}), /\(CLAUDE\.md\)/)
})

test('more than four names are counted, not listed', () => {
  const agents = ['a', 'b', 'c', 'd', 'e', 'f'].map(n => `.claude/agents/${n}.md`)
  assert.match(roleHookText({ agents, rules: [] }, {}), /\(\.claude\/agents\/a\.md, .*d\.md and 2 more\)/)
  assert.doesNotMatch(roleHookText({ agents: agents.slice(0, 4), rules: [] }, {}), /more\)/)
})

test('switched off by the environment variable or by the repo line', () => {
  const declared = { agents: ['.claude/agents/dev.md'], rules: [] }
  for (const v of ['0', 'off', ' OFF ', 'false', 'no']) assert.equal(roleHookText(declared, { [SWITCH_ENV]: v }), '', v)
  for (const v of ['1', 'on', '']) assert.notEqual(roleHookText(declared, { [SWITCH_ENV]: v }), '', v)
  assert.equal(roleHookText({ agents: ['x'], rules: [{ path: 'AGENTS.md', text: `${RULES}\n  craft-role-hook: off\n` }] }, {}), '')
  assert.notEqual(roleHookText({ agents: ['x'], rules: [{ path: 'AGENTS.md', text: 'say craft-role-hook: off here' }] }, {}), '')
})

test('the repo root is the nearest .git above the start; without one, the start itself', () => {
  const root = repo({ 'a/b/keep': '' })
  assert.equal(findRepoRoot(path.join(root, 'a', 'b')), root)
  fs.rmSync(path.join(root, '.git'), { recursive: true })
  fs.writeFileSync(path.join(root, '.git'), 'gitdir: elsewhere\n')
  assert.equal(findRepoRoot(path.join(root, 'a')), root)
  const bare = tmp()
  assert.equal(findRepoRoot(bare), bare)
})

test('declarations: project agents (.md only, sorted) and each rules file once, even through a symlink', () => {
  const root = repo({ '.claude/agents/z.md': '', '.claude/agents/a.md': '', '.claude/agents/notes.txt': '', 'AGENTS.md': RULES })
  fs.symlinkSync('AGENTS.md', path.join(root, 'CLAUDE.md'))
  assert.deepEqual(readDeclarations(root), { agents: ['.claude/agents/a.md', '.claude/agents/z.md'], rules: [{ path: 'AGENTS.md', text: RULES }] })
  assert.deepEqual(readDeclarations(repo({})), { agents: [], rules: [] })
})

test('the hook output carries the text as SessionStart additionalContext, read from the input cwd', () => {
  const root = repo({ '.claude/agents/dev.md': '' })
  const out = JSON.parse(sessionStartOutput(JSON.stringify({ cwd: path.join(root), hook_event_name: 'SessionStart' }), {}, os.tmpdir()))
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart')
  assert.match(out.hookSpecificOutput.additionalContext, /\.claude\/agents\/dev\.md/)
  assert.equal(sessionStartOutput('not json', {}, repo({})), '')
  assert.notEqual(sessionStartOutput('{}', {}, root), '')
})

test('the hook script never fails: unreadable stdin is the process cwd, and it exits 0', async () => {
  const r = await run([], {}, () => { throw new Error('no stdin') })
  assert.equal(r.exitCode, 0)
  const root = repo({ '.claude/agents/dev.md': '' })
  const spoken = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd: root }), encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' } })
  assert.equal(spoken.status, 0)
  assert.match(spoken.stdout, /additionalContext/)
  const silent = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd: root }), encoding: 'utf8', env: { [SWITCH_ENV]: '0' } })
  assert.equal(silent.status, 0)
  assert.equal(silent.stdout, '')
  const broken = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd: '/nonexistent/x' }), encoding: 'utf8' })
  assert.equal(broken.status, 0)
  assert.equal(broken.stderr, '')
})
