// The Codex delivery: a `.codex-plugin/plugin.json` at the repo root and a marketplace at
// `.agents/plugins/marketplace.json` whose plugin is the repo root itself. Codex copies only the plugin root into
// its cache, and reads `skills/` and `hooks/hooks.json` there, so the skills, hooks and lib/ shared with the Claude
// Code delivery reach it unchanged (probe: codex-cli 0.160.0, `codex plugin marketplace add` + `codex exec`).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { workHook } from './work-hook.mjs'
import { readDeclarations, sessionStart } from './role-hook.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** @param {string} rel @returns {any} */
const json = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'))

test('the Codex manifest names craft at the Claude Code manifest\'s version and points at the shared skills', () => {
  const codex = json('.codex-plugin/plugin.json')
  const claude = json('.claude-plugin/plugin.json')
  assert.equal(codex.name, claude.name)
  assert.equal(codex.version, claude.version, 'release-please moves both (release-please-config.json extra-files)')
  assert.equal(codex.skills, './skills/')
  assert.ok(fs.readdirSync(path.join(ROOT, 'skills')).some(d => fs.existsSync(path.join(ROOT, 'skills', d, 'SKILL.md'))))
  const extra = json('release-please-config.json').packages['.']['extra-files'].map((/** @type {{ path: string }} */ f) => f.path)
  assert.ok(extra.includes('.codex-plugin/plugin.json'))
})

test('the Codex marketplace offers craft from the repo root, where lib/ and hooks/ live', () => {
  const market = json('.agents/plugins/marketplace.json')
  assert.equal(market.name, 'craft')
  assert.deepEqual(market.plugins.map((/** @type {{ name: string, source: unknown }} */ p) => [p.name, p.source]), [['craft', { source: 'local', path: '.' }]])
})

test('every hook command runs a lib/ script that exists, through the root variable Codex also sets', () => {
  const hooks = json('hooks/hooks.json').hooks
  assert.deepEqual(Object.keys(hooks).sort(), ['PreToolUse', 'SessionStart', 'SubagentStart', 'UserPromptSubmit'])
  for (const groups of Object.values(hooks)) {
    for (const { hooks: list } of groups) {
      for (const { command } of list) {
        const script = /\$\{CLAUDE_PLUGIN_ROOT\}\/(lib\/[\w-]+\.mjs)/.exec(command)?.[1]
        assert.ok(script && fs.existsSync(path.join(ROOT, script)), command)
      }
    }
  }
})

test('a Codex subagent\'s own UserPromptSubmit (agent_id, the brief as prompt) is neither said to nor logged', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-codex-')))
  try {
    fs.mkdirSync(path.join(root, '.git'))
    fs.mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true })
    fs.writeFileSync(path.join(root, '.claude', 'agents', 'dev.md'), '')
    const brief = { hook_event_name: 'UserPromptSubmit', cwd: root, session_id: 's', prompt: 'fix the PR comments' }
    const now = new Date('2026-10-21T12:00:00Z')
    assert.equal(workHook(JSON.stringify(brief), {}, root, now, () => []).entry?.spoke, true, 'the main session\'s prompt speaks')
    const sub = workHook(JSON.stringify({ ...brief, agent_id: 'a1', agent_type: 'default' }), {}, root, now, () => [])
    assert.deepEqual(sub, { stdout: '', entry: null })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// Codex loads a trusted project's `.codex/agents/*.toml` as agent roles (observed: codex-cli 0.160.0, the role in
// spawn_agent's agent_type list sent to a local fake Responses endpoint; a `.md` file there was not loaded).
test('under Codex the project\'s own role files count as declared roles; under Claude Code they do not', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-codex-')))
  try {
    fs.mkdirSync(path.join(root, '.git'))
    fs.mkdirSync(path.join(root, '.codex', 'agents'), { recursive: true })
    for (const f of ['dev.toml', 'notes.md']) fs.writeFileSync(path.join(root, '.codex', 'agents', f), '')
    assert.deepEqual(readDeclarations(root, 'codex').agents, ['.codex/agents/dev.toml'])
    assert.deepEqual(readDeclarations(root).agents, [])
    const now = new Date('2026-10-21T12:00:00Z')
    const start = sessionStart(JSON.stringify({ cwd: root }), { PLUGIN_ROOT: '/p' }, root, now)
    assert.deepEqual([start.entry.spoke, start.entry.found], [true, ['.codex/agents/dev.toml']])
    assert.equal(sessionStart(JSON.stringify({ cwd: root }), {}, root, now).stdout, '')
    const prompt = { hook_event_name: 'UserPromptSubmit', cwd: root, session_id: 's', prompt: 'review the branch' }
    assert.equal(workHook(JSON.stringify({ ...prompt, turn_id: 't1' }), {}, root, now, () => []).entry?.spoke, true)
    assert.equal(workHook(JSON.stringify(prompt), {}, root, now, () => []).entry?.spoke, false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
