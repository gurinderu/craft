import { afterAll, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendHookLog, hookLogPath, readHookLog } from './hook-log.mjs'
import { craftAgent, workHook } from './work-hook.mjs'
import { opencodeMessage } from './work-hook-opencode.mjs'
import { CODEX_SUBAGENT_TEXT, SUBAGENT_TEXT } from './work-hook-text.mjs'
import { run } from './work-hook-entry.mjs'

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

test('SubagentStart stays silent for craft\'s own agents, writes no log line, and speaks to the rest', async () => {
  const root = repo()
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-agent-home-')))
  made.push(home)
  const file = hookLogPath(home)
  /** @type {HookEntry} */
  const spoke = { ts: NOW.toISOString(), repo: root, source: '', event: 'UserPromptSubmit', session: 's1', kind: 'review', spoke: true, found: [], silent: null }
  appendHookLog(spoke, file)
  const start = async (/** @type {string} */ agent, extra = {}) =>
    (await run([], {}, () => JSON.stringify({ hook_event_name: 'SubagentStart', cwd: root, session_id: 's1', agent_type: agent, ...extra }), home)).stdout.join('')
  const lines = () => readHookLog(file)?.length
  for (const agent of ['craft:rust-reviewer', 'rust-reviewer', 'nix-reviewer', 'workflow-subagent']) {
    assert.equal(await start(agent), '', agent)
    assert.equal(lines(), 1, `${agent}: no log line`)
    // Decided before the log is read.
    assert.deepEqual(workHook(JSON.stringify({ hook_event_name: 'SubagentStart', cwd: root, session_id: 's1', agent_type: agent }), {}, os.tmpdir(), NOW, () => { throw new Error('log read') }), { stdout: '', entry: null })
  }
  // Codex reaches the same path: the same silence for craft's agents, its own text for the rest.
  const codex = { turn_id: 't1', agent_id: 'a1' }
  assert.equal(await start('craft:rust-reviewer', codex), '')
  assert.equal(lines(), 1)
  assert.equal(JSON.parse(await start('worker', codex)).hookSpecificOutput.additionalContext, CODEX_SUBAGENT_TEXT)
  for (const agent of ['general-purpose', 'dev']) assert.equal(JSON.parse(await start(agent)).hookSpecificOutput.additionalContext, SUBAGENT_TEXT, agent)
  assert.deepEqual(readHookLog(file)?.map(e => [e.agent, e.spoke]), [[undefined, true], ['worker', true], ['general-purpose', true], ['dev', true]])
})

test('an OpenCode subagent session of a craft agent stays silent and unlogged', () => {
  const cwd = repo()
  const brief = (/** @type {string} */ agent) => opencodeMessage({ prompt: 'review the PR', session: 'c', cwd, parent: 'p', agent }, {}, NOW, () => [])
  assert.deepEqual(brief('rust-reviewer'), { text: '', entry: null })
  assert.deepEqual(brief('craft:rust-miri'), { text: '', entry: null })
  assert.notEqual(brief('general').text, '')
})
