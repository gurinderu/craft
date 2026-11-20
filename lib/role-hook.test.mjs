// The repo test the OpenCode work hook makes (lib/work-hook-opencode.mjs); the Claude Code and Codex hooks make the
// same one in the craft binary (cli/bin/craft/src/hook/role/declared.rs), held to the Node answers by
// content/parity/hook-cases.json.
import { afterAll, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findRepoRoot, readDeclarations, roleHookDecision, SWITCH_ENV } from './role-hook.mjs'

/** @type {string[]} */
const made = []
afterAll(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true })
})

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

/** Whether the decision speaks on `text` as the repo's AGENTS.md. @param {string} text */
const speaks = text => roleHookDecision({ agents: [], rules: [{ path: 'AGENTS.md', text }] }, {}).silent === null

test('silent when the repo declares nothing, or only describes its code', () => {
  assert.equal(roleHookDecision({ agents: [], rules: [] }, {}).silent, 'nothing-declared')
  assert.equal(speaks('# Build\nnpm test\n'), false)
})

test('code prose that only shares a word with the process stays silent', () => {
  for (const text of [
    'Config uses a deep merge of defaults.',
    'Keep branch coverage above 80%.',
    'Each commit of the index is atomic.',
    'Review the docs/ folder for the API.',
    'The parser handles pr, prs and Pr tokens.',
    'The reviews table stores ratings.',
  ])
    assert.equal(speaks(text), false, text)
})

test('each process phrase counts as work rules', () => {
  for (const text of [
    'Open a pull request.',
    'One PR per change.',
    'PRs need a green CI.',
    'Every code review is async.',
    'Ask the reviewer.',
    'Run the review loop.',
    'Rebase before merging.',
    'Squash before merge.',
  ])
    assert.equal(speaks(text), true, text)
  assert.deepEqual(roleHookDecision({ agents: ['.claude/agents/dev.md'], rules: [{ path: 'AGENTS.md', text: RULES }] }, {}).found, [
    '.claude/agents/dev.md',
    'AGENTS.md',
  ])
})

test('switched off by the environment variable or by the repo line', () => {
  const declared = { agents: ['.claude/agents/dev.md'], rules: [] }
  for (const v of ['0', 'off', ' OFF ', 'false', 'no']) assert.equal(roleHookDecision(declared, { [SWITCH_ENV]: v }).silent, 'off-env', v)
  for (const v of ['1', 'on', '']) assert.equal(roleHookDecision(declared, { [SWITCH_ENV]: v }).silent, null, v)
  assert.equal(roleHookDecision({ agents: ['x'], rules: [{ path: 'AGENTS.md', text: `${RULES}\n  craft-role-hook: off\n` }] }, {}).silent, 'off-line')
  assert.equal(roleHookDecision({ agents: ['x'], rules: [{ path: 'AGENTS.md', text: 'say craft-role-hook: off here' }] }, {}).silent, null)
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

test("in OpenCode the project's own .opencode/agents count, the symlinks craft's installer puts there do not", () => {
  const root = repo({ '.opencode/agents/dev.md': '', '.claude/agents/a.md': '' })
  fs.symlinkSync(path.join(root, '.claude/agents/a.md'), path.join(root, '.opencode/agents/rust-reviewer.md'))
  assert.deepEqual(readDeclarations(root, 'opencode').agents, ['.claude/agents/a.md', '.opencode/agents/dev.md'])
  assert.deepEqual(readDeclarations(root).agents, ['.claude/agents/a.md'], 'Claude Code does not read OpenCode agents')
})

test('the decision names why it is silent', () => {
  const declared = { agents: ['.claude/agents/dev.md'], rules: [{ path: 'AGENTS.md', text: 'craft-role-hook: off' }] }
  assert.deepEqual(roleHookDecision(declared, { [SWITCH_ENV]: '0' }), { found: [], silent: 'off-env' })
  assert.deepEqual(roleHookDecision(declared, {}), { found: [], silent: 'off-line' })
  assert.deepEqual(roleHookDecision({ agents: [], rules: [] }, {}), { found: [], silent: 'nothing-declared' })
})
