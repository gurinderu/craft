import { afterAll, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderHookSection } from './hook-log.mjs'
import { craftAgent, workHook } from './work-hook.mjs'
import { opencodeMessage } from './work-hook-opencode.mjs'
import { CODEX_SUBAGENT_TEXT, SUBAGENT_TEXT } from './work-hook-text.mjs'

/** @typedef {import('./hook-log.mjs').HookEntry} HookEntry */
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const NOW = new Date('2026-10-20T12:00:00Z')
/** @type {string[]} */
const made = []
afterAll(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }) })

/** A throwaway repo with a declared project agent. @returns {string} */
function repo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-agent-hook-')))
  made.push(root)
  fs.mkdirSync(path.join(root, '.git'))
  fs.mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true })
  fs.writeFileSync(path.join(root, '.claude', 'agents', 'dev.md'), '')
  return root
}

/** @param {string} dir @returns {string[]} */
const names = dir => fs.readdirSync(path.join(ROOT, dir)).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3))

test('every agent craft ships, in either delivery, is craft\'s own by its bare and its namespaced name', () => {
  for (const name of new Set([...names('agents'), ...names('opencode/agents')])) {
    assert.ok(craftAgent(name), name)
    assert.ok(craftAgent(`craft:${name}`), name)
  }
  assert.ok(craftAgent('workflow-subagent'))
  for (const other of ['general-purpose', 'dev', 'worker', 'reviewer', 'rust-reviewer-2', '']) assert.ok(!craftAgent(other), other)
})

test('SubagentStart stays silent for craft\'s own agents, logged as craft-agent, and speaks to the rest', () => {
  const root = repo()
  /** @type {HookEntry} */
  const spoke = { ts: NOW.toISOString(), repo: root, source: '', event: 'UserPromptSubmit', session: 's1', kind: 'review', spoke: true, found: [], silent: null }
  const start = (/** @type {string} */ agent, extra = {}) =>
    workHook(JSON.stringify({ hook_event_name: 'SubagentStart', cwd: root, session_id: 's1', agent_type: agent, ...extra }), {}, os.tmpdir(), NOW, () => [spoke])
  for (const agent of ['craft:rust-reviewer', 'rust-reviewer', 'nix-reviewer', 'workflow-subagent']) {
    const run = start(agent)
    assert.equal(run.stdout, '', agent)
    assert.deepEqual(run.entry && { spoke: run.entry.spoke, silent: run.entry.silent, agent: run.entry.agent, event: run.entry.event },
      { spoke: false, silent: 'craft-agent', agent, event: 'SubagentStart' }, agent)
  }
  for (const agent of ['general-purpose', 'dev']) {
    const run = start(agent)
    assert.equal(JSON.parse(run.stdout).hookSpecificOutput.additionalContext, SUBAGENT_TEXT, agent)
    assert.equal(run.entry?.spoke, true, agent)
  }
  // Codex reaches the same path: its own subagent text, the same silence for craft's agents.
  const codex = { turn_id: 't1', agent_id: 'a1' }
  assert.equal(start('craft:rust-reviewer', codex).entry?.silent, 'craft-agent')
  assert.equal(JSON.parse(start('worker', codex).stdout).hookSpecificOutput.additionalContext, CODEX_SUBAGENT_TEXT)
})

test('an OpenCode subagent session of a craft agent stays silent, logged as craft-agent', () => {
  const cwd = repo()
  const brief = (/** @type {string} */ agent) => opencodeMessage({ prompt: 'review the PR', session: 'c', cwd, parent: 'p', agent }, {}, NOW, () => [])
  assert.deepEqual(brief('rust-reviewer'), { text: '', entry: { ...brief('general').entry, agent: 'rust-reviewer', spoke: false, silent: 'craft-agent' } })
  assert.notEqual(brief('general').text, '')
})

test('the hooks report counts the craft-agent silence as its own reason', () => {
  /** @type {HookEntry} */
  const e = { ts: NOW.toISOString(), repo: '/r', source: '', event: 'SubagentStart', session: 's', agent: 'craft:rust-reviewer', spoke: false, found: [], silent: 'craft-agent' }
  assert.match(renderHookSection([e, e, { ...e, agent: 'general-purpose', spoke: true, silent: null }], []).join('\n'), /- SubagentStart: 3 run\(s\) \u2014 spoke 1, silent 2 \(craft-agent 2\)/)
})
