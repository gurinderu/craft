// The Codex delivery: a `.codex-plugin/plugin.json` at the repo root and a marketplace at
// `.agents/plugins/marketplace.json` whose plugin is the repo root itself. Codex copies only the plugin root into
// its cache, and leaves out every symlink in it (observed: codex-cli 0.167.0, a local marketplace whose plugin root
// was integrations/codex with skills/ and lib/ linked in — the cache held only .codex-plugin/), so the plugin root
// stays the repo root, where skills/ and lib/ are real directories. Its manifest names the Claude Code delivery's
// hooks file (`hooks`, a path inside the plugin root), which Codex reads in place of hooks/hooks.json (observed:
// the app-server's hooks/list named integrations/claude-code/hooks/hooks.json and the cache root's lib/ scripts).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** @param {string} rel @returns {any} */
const json = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'))

test("the Codex manifest names craft at the Claude Code manifest's version and points at the shared skills", () => {
  const codex = json('.codex-plugin/plugin.json')
  const claude = json('integrations/claude-code/.claude-plugin/plugin.json')
  assert.equal(codex.name, claude.name)
  assert.equal(codex.version, claude.version, 'release-please moves both (release-please-config.json extra-files)')
  assert.equal(codex.skills, './skills/')
  assert.equal(codex.hooks, './integrations/claude-code/hooks/hooks.json', "the Claude Code delivery's hooks, read in place")
  assert.ok(fs.existsSync(path.join(ROOT, codex.hooks)))
  assert.ok(fs.readdirSync(path.join(ROOT, 'skills')).some(d => fs.existsSync(path.join(ROOT, 'skills', d, 'SKILL.md'))))
  const extra = json('release-please-config.json').packages['.']['extra-files'].map((/** @type {{ path: string }} */ f) => f.path)
  assert.ok(extra.includes('.codex-plugin/plugin.json'))
})

test('the Codex marketplace offers craft from the repo root, where skills/ and lib/ are real directories', () => {
  const market = json('.agents/plugins/marketplace.json')
  assert.equal(market.name, 'craft')
  assert.deepEqual(
    market.plugins.map((/** @type {{ name: string, source: unknown }} */ p) => [p.name, p.source]),
    [['craft', { source: 'local', path: '.' }]],
  )
})

test('every hook command runs a lib/ script that exists, through the root variable Codex also sets', () => {
  const hooks = json('integrations/claude-code/hooks/hooks.json').hooks
  assert.deepEqual(Object.keys(hooks).sort(), ['PostToolUse', 'PreToolUse', 'SessionStart', 'SubagentStart', 'UserPromptSubmit'])
  for (const groups of Object.values(hooks)) {
    for (const { hooks: list } of groups) {
      for (const { command } of list) {
        const script = /\$\{CLAUDE_PLUGIN_ROOT\}\/(lib\/[\w-]+\.(?:mjs|sh))/.exec(command)?.[1]
        assert.ok(script && fs.existsSync(path.join(ROOT, script)), command)
      }
    }
  }
})
