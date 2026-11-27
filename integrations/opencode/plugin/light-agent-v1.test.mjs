// The light review-task agent's system text on OpenCode 1.x (light-agent-v1.ts), over system texts shaped as opencode
// 1.19.5 handed them to a probe plugin's `experimental.chat.system.transform` hook (realm @nick/craft, nodes #294,
// #707): one string — the agent's prompt, the host's model line and environment, then each rule file the host loaded
// under `Instructions from: `.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseMarkdown } from './frontmatter.ts'
import { lightenSystem } from './light-agent-v1.ts'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
/** The agent's prompt as its file spells it: 1.19.5 opens the system text of its sessions with it. */
const PROMPT = parseMarkdown(fs.readFileSync(path.join(REPO, 'integrations/opencode/agents/review-task.md'), 'utf8')).body
/** The file's first sentence. */
const OPENING = PROMPT.slice(0, PROMPT.indexOf('.') + 1)
const MODEL = 'You are powered by the model named fake-model. The exact model ID is fake/fake-model'
const ENV_HEAD = 'Here is some useful information about the environment you are running in:'
const ENV = [
  ENV_HEAD,
  '<env>',
  '  Working directory: /stand/proj',
  '  Workspace root folder: /stand/proj',
  '  Is directory a git repo: yes',
  '  Platform: linux',
  "  Today's date: Fri Nov 27 2026",
  '</env>',
].join('\n')
/** What stays: the agent's prompt and the host's own lines before the rule files. */
const OWN = `${PROMPT}\n${MODEL}\n${ENV}`
const RULES = 'Instructions from: /stand/proj/AGENTS.md\n# Stand rules\n\nMARKER-RULES-5b1c\n\nAlways answer with the word PINEAPPLE.'
const GLOBAL_RULES = 'Instructions from: /stand/config/opencode/AGENTS.md\n# Global rules\n\nMARKER-GLOBAL-e5f1'
const NAMED_RULES = 'Instructions from: /stand/proj/extra.md\n# Named in the config\n\nMARKER-NAMED-9a3b'
const SKILLS =
  '<available_skills>\n  <skill>\n    <name>rust-review</name>\n    <location>/stand/proj/.opencode/skills/rust-review/SKILL.md</location>\n  </skill>\n</available_skills>'
const RULES_OF_THE_REPOSITORY = /MARKER-RULES|MARKER-GLOBAL|MARKER-NAMED|Instructions from:|PINEAPPLE/

test("the agent's session is told by the opening of its file: a system text that opens with the file's prompt loses its rule file, and keeps the rest byte for byte", () => {
  assert.ok(OPENING.length > 20 && PROMPT.length > OPENING.length, 'the file opens with a sentence of its own, before more')
  const system = [`${OWN}\n${RULES}\n`]
  lightenSystem(system)
  assert.deepEqual(system, [`${OWN}\n`])
  assert.doesNotMatch(/** @type {string} */ (system[0]), RULES_OF_THE_REPOSITORY)
})

test('the first sentence of the file is all it takes to tell the session', () => {
  const system = [`${OPENING}\n\nA paragraph no file of ours spells.\n${ENV}\n${RULES}`]
  lightenSystem(system)
  assert.deepEqual(system, [`${OPENING}\n\nA paragraph no file of ours spells.\n${ENV}\n`])
})

test('every rule file goes — the config folder’s, the project’s, one the config names — and nothing of their text stays', () => {
  const system = [`${OWN}\n${GLOBAL_RULES}\n\n${RULES}\n\n${NAMED_RULES}\n`]
  lightenSystem(system)
  assert.deepEqual(system, [`${OWN}\n`])
  assert.doesNotMatch(/** @type {string} */ (system[0]), RULES_OF_THE_REPOSITORY)
})

test('the same blocks as separate strings are cut the same way, and a string that is only rule files leaves the array', () => {
  const system = [PROMPT, MODEL, ENV, `${RULES}\n\n${GLOBAL_RULES}`]
  lightenSystem(system)
  assert.deepEqual(system, [PROMPT, MODEL, ENV])
  // A string that leaves the array stands before one still to be cut: the removal skips none of the strings after it.
  const apart = [PROMPT, RULES, `${MODEL}\n${ENV}\n${NAMED_RULES}\n${SKILLS}`]
  lightenSystem(apart)
  assert.deepEqual(apart, [PROMPT, `${MODEL}\n${ENV}\n`])
})

test('everything after the first rule file goes with it: the rest of that string is not known to be the host’s own', () => {
  // The host's skills block ends the general agent's text; nothing of the host was seen after a rule file in this
  // agent's, and a text between two rule files is a rule file's own.
  const system = [`${OWN}\n${RULES}\n\nAppended by a newer 1.x.\n`, `${OWN}\n${RULES}\n${NAMED_RULES}\n${SKILLS}`]
  lightenSystem(system)
  assert.deepEqual(system, [`${OWN}\n`, `${OWN}\n`])
})

test("a line of the host's that quotes the header in its middle is no rule file: only a line that begins with it is cut", () => {
  const quoted = 'The file says "Instructions from: /stand/proj/sub/AGENTS.md" at its top.'
  const system = [`${PROMPT}\n${quoted}\n${MODEL}\n${ENV}\n${RULES}`]
  lightenSystem(system)
  assert.deepEqual(system, [`${PROMPT}\n${quoted}\n${MODEL}\n${ENV}\n`])
})

test("another session's system text passes as it came: a general agent's, the session title's, a prompt that opens like the agent's but is not its file's, and one that carries the agent's opening in its middle", () => {
  // The session's title request, as the probe recorded it: under the agent's session id, with a system text of its own.
  const TITLE =
    'You are a title generator. You output ONLY a thread title. Nothing else.\n\n<task>\nGenerate a brief title that would help the user find this conversation later.\n</task>'
  const GENERAL = 'You are opencode, an interactive CLI tool that helps users with software engineering tasks.'
  const ALIKE = `${OPENING.slice(0, -1)}, or so another agent's file begins.`
  const system = [
    [`${TITLE}\n${RULES}`],
    [`${GENERAL}\n${MODEL}\n${ENV}\n${RULES}\n${SKILLS}`],
    [`${ALIKE}\n${MODEL}\n${ENV}\n${RULES}`],
    [`${GENERAL}\n${OPENING}\n${MODEL}\n${ENV}\n${RULES}`],
  ]
  const before = system.map(s => [...s])
  for (const text of system) {
    lightenSystem(text)
  }
  assert.deepEqual(system, before)
  assert.ok(
    system.every((s, i) => s.every((text, j) => text === before[i]?.[j])),
    'the same strings, not copies of them',
  )
})

test('a shape not recorded is left as it came, and nothing throws', () => {
  const shapes = [undefined, null, 'Instructions from: /stand/proj/AGENTS.md', 7, {}, [], [null, 5, {}, [PROMPT]], [`${PROMPT}\n${RULES}`, null, 5]]
  for (const shape of shapes) {
    assert.doesNotThrow(() => lightenSystem(shape))
    assert.doesNotThrow(() => lightenSystem(shape))
  }
  assert.deepEqual(shapes.at(-1), [`${PROMPT}\n`, null, 5], 'the strings are cut, the others are not read')
})
