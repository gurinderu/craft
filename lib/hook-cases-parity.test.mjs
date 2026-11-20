// The prompt classes in content/parity/hook-cases.json, frozen when the Claude Code and Codex hooks moved into the craft
// binary (realm @nick/craft, node #538), which its parity test holds them to (cli/bin/craft/src/hook/role/parity.rs).
// The OpenCode work hook still classes prompts here (lib/work-hook-kind.mjs): the two must keep giving the same class.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { promptKind } from './work-hook-kind.mjs'

/** @type {{ kinds: { prompt: string, recent: import('./work-hook-kind.mjs').PromptKind | null, kind: string | null }[] }} */
const CASES = JSON.parse(fs.readFileSync(new URL('../content/parity/hook-cases.json', import.meta.url), 'utf8'))

test('every prompt takes the class the craft binary gives it', () => {
  assert.ok(CASES.kinds.length > 100)
  for (const { prompt, recent, kind } of CASES.kinds) assert.equal(promptKind(prompt, recent), kind, prompt)
})
