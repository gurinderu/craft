// The OpenCode side of craft's hook at the moment of work: the core (work-hook.ts), driven through the 1.x adapter's
// `chat.message` and `event` (host-v1.ts), against a stand-in craft binary (CRAFT_BIN) that records what it is asked.
// The decision itself is the binary's, held to the Node hooks it replaced by content/parity/hook-cases.json
// (cli/bin/craft/src/hook/role/opencode.rs; realm @nick/craft, node #550). The 2.x adapter's mapping is in
// host-v2.test.mjs.
import { afterAll, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { v1WorkHooks } from './host-v1.ts'
import { workHook } from './work-hook.ts'
import { writeExecutable } from '../../shared/write-executable.mjs'

/** @type {string[]} */
const made = []
afterAll(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true })
})
const tmp = () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-oc-plugin-')))
  made.push(d)
  return d
}

// Each call's arguments and input as one JSON line; the lines for a prompt that names a review.
const FAKE = `#!/bin/sh
input=$(cat)
printf '{"args":"%s","input":%s}\\n' "$*" "$input" >> "$CALLS"
case $input in *review*) printf 'craft: lines\\n' ;; esac
`

/** @param {Record<string, string>} [env] @param {Set<string>} [engine] */
function setup(env, engine = new Set()) {
  const root = tmp()
  const home = tmp()
  const calls = path.join(home, 'calls')
  const bin = path.join(home, 'craft')
  writeExecutable(bin, FAKE)
  const hooks = v1WorkHooks(workHook(root, engine, home, env ?? { CRAFT_BIN: bin, CALLS: calls, PATH: process.env['PATH'] }))
  // The fakes carry only the fields the hook reads.
  const message = /** @type {(input: any, output: any) => Promise<void>} */ (hooks['chat.message'])
  const event = /** @type {(input: any) => Promise<void>} */ (hooks.event)
  /** @returns {{ args: string, input: Record<string, unknown> }[]} */
  const seen = () =>
    fs.existsSync(calls)
      ? fs
          .readFileSync(calls, 'utf8')
          .trim()
          .split('\n')
          .map(l => JSON.parse(l))
      : []
  return { root, home, message, event, seen }
}

/** A message's output as chat.message receives it. @param {string} session @param {string} text */
const output = (session, text) => ({ message: {}, parts: [{ id: 'prt_1', sessionID: session, messageID: 'msg_1', type: 'text', text }] })

test('a message goes to `craft hook opencode-message`, and the lines it prints become one synthetic part', async () => {
  const { root, message, seen } = setup()
  const out = output('s1', 'review the branch')
  await message({ sessionID: 's1', agent: 'build' }, out)
  assert.deepEqual(
    { ...out.parts[1], text: undefined },
    { id: 'prt_1-craft', sessionID: 's1', messageID: 'msg_1', type: 'text', text: undefined, synthetic: true },
  )
  assert.equal(out.parts[1]?.['text'], 'craft: lines')
  const quiet = output('s1', 'write the parser')
  await message({ sessionID: 's1' }, quiet)
  assert.equal(quiet.parts.length, 1, 'nothing printed, nothing added')
  assert.deepEqual(seen(), [
    { args: 'hook opencode-message', input: { prompt: 'review the branch', session: 's1', cwd: root, placeable: true } },
    { args: 'hook opencode-message', input: { prompt: 'write the parser', session: 's1', cwd: root, placeable: true } },
  ])
})

test("a subagent session's first message carries its parent and agent, later ones and engine sessions are not asked", async () => {
  const { root, message, event, seen } = setup(undefined, new Set(['engine']))
  await event({ event: { type: 'session.created', properties: { info: { id: 'c', parentID: 'p' } } } })
  const first = output('c', 'review the parser')
  await message({ sessionID: 'c', agent: 'general' }, first)
  assert.equal(first.parts.length, 2)
  await message({ sessionID: 'c', agent: 'general' }, output('c', 'review it'))
  await message({ sessionID: 'engine', agent: 'rust-reviewer' }, output('engine', 'review this diff'))
  await event({ event: { type: 'session.compacted', properties: { sessionID: 'p' } } })
  assert.deepEqual(seen(), [
    { args: 'hook opencode-message', input: { prompt: 'review the parser', session: 'c', cwd: root, placeable: true, parent: 'p', agent: 'general' } },
    { args: 'hook opencode-compacted', input: { session: 'p', cwd: root } },
  ])
})

test('a message with nothing to build the part on is asked as not placeable, and bad input never throws', async () => {
  const { message, event, seen } = setup()
  const odd = { message: {}, parts: [{ type: 'text', text: 'review it' }] }
  await message({ sessionID: 's' }, odd)
  assert.equal(odd.parts.length, 1)
  assert.equal(seen().at(-1)?.input['placeable'], false)
  await message({ sessionID: 's' }, null)
  await event({ event: null })
})

test('a binary that fails says nothing', async () => {
  const home = tmp()
  const bin = path.join(home, 'craft')
  writeExecutable(bin, '#!/bin/sh\necho broken\nexit 3\n')
  const hooks = v1WorkHooks(workHook(tmp(), new Set(), home, { CRAFT_BIN: bin }))
  const out = output('s1', 'review the branch')
  await /** @type {(input: any, output: any) => Promise<void>} */ (hooks['chat.message'])({ sessionID: 's1' }, out)
  assert.equal(out.parts.length, 1)
})
