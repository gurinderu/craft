import { afterAll, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { craftAgent } from './work-hook.mjs'
import { opencodeMessage } from './work-hook-opencode.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const NOW = new Date('2026-10-20T12:00:00Z')
/** @type {string[]} */
const made = []
afterAll(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true })
})

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
const names = dir =>
  fs
    .readdirSync(path.join(ROOT, dir))
    .filter(f => f.endsWith('.md'))
    .map(f => f.slice(0, -3))

test("every agent craft ships, in either delivery, is craft's own by its bare and its namespaced name", () => {
  for (const name of new Set([...names('integrations/claude-code/agents'), ...names('integrations/opencode/agents')])) {
    assert.ok(craftAgent(name), name)
    assert.ok(craftAgent(`craft:${name}`), name)
  }
  assert.ok(craftAgent('workflow-subagent'))
  for (const other of ['general-purpose', 'dev', 'worker', 'reviewer', 'rust-reviewer-2', '']) assert.ok(!craftAgent(other), other)
})

test('an OpenCode subagent session of a craft agent stays silent and unlogged', () => {
  const cwd = repo()
  const brief = (/** @type {string} */ agent) => opencodeMessage({ prompt: 'review the PR', session: 'c', cwd, parent: 'p', agent }, {}, NOW, () => [])
  assert.deepEqual(brief('rust-reviewer'), { text: '', entry: null })
  assert.deepEqual(brief('craft:rust-miri'), { text: '', entry: null })
  assert.notEqual(brief('general').text, '')
})
