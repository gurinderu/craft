// The OpenCode side of craft's hook at the moment of work: what it reads from OpenCode's hooks and writes back.
import { afterAll, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { workHooks } from './work-hook.ts'

/** @type {string[]} */
const made = []
afterAll(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }) })
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-oc-plugin-'))); made.push(d); return d }

function setup(engine = new Set()) {
  const root = tmp()
  fs.mkdirSync(path.join(root, '.git'))
  fs.mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true })
  fs.writeFileSync(path.join(root, '.claude', 'agents', 'dev.md'), '')
  const home = tmp()
  const hooks = workHooks(root, engine, home, {})
  // The fakes carry only the fields the hook reads.
  const message = /** @type {(input: any, output: any) => Promise<void>} */ (hooks['chat.message'])
  const event = /** @type {(input: any) => Promise<void>} */ (hooks.event)
  const log = () => fs.readFileSync(path.join(home, '.craft', 'hooks.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  return { message, event, log }
}

/**
 * A message's output as chat.message receives it. @param {string} session @param {string} text
 * @returns {{ message: object, parts: Array<Record<string, unknown>> }}
 */
const output = (session, text) => ({ message: {}, parts: [{ id: 'prt_1', sessionID: session, messageID: 'msg_1', type: 'text', text }] })

test('a review request gets one synthetic part after its own, logged as chat.message', async () => {
  const { message, event, log } = setup()
  const out = output('s1', 'address the review findings')
  await message({ sessionID: 's1', agent: 'build' }, out)
  assert.equal(out.parts.length, 2)
  assert.deepEqual({ ...out.parts[1], text: undefined }, { id: 'prt_1-craft', sessionID: 's1', messageID: 'msg_1', type: 'text', text: undefined, synthetic: true })
  const text = String(out.parts[1]?.['text'])
  assert.match(text, /make one call: load the addressing-findings skill with the skill tool/)
  assert.equal(text.split('\n').length, 7)
  const again = output('s1', 'more findings')
  await message({ sessionID: 's1' }, again)
  assert.equal(again.parts.length, 1, 'once per session and class')
  const review = output('s1', 'review it')
  await message({ sessionID: 's1' }, review)
  assert.match(String(review.parts[1]?.['text']), /make one call: for Rust code, load the rust-review skill/, 'the other class speaks its own lines')
  assert.deepEqual(log().map(e => [e.event, e.harness, e.session, e.spoke, e.kind]), [['chat.message', 'opencode', 's1', true, 'findings'], ['chat.message', 'opencode', 's1', false, 'findings'], ['chat.message', 'opencode', 's1', true, 'review']])
  await event({ event: { type: 'session.compacted', properties: { sessionID: 's1' } } })
  const after = output('s1', 'review again')
  await message({ sessionID: 's1' }, after)
  assert.equal(after.parts.length, 2, 'a compaction lets it speak again')
})

test('a subagent session hears its lines on its first message only; engine sessions hear nothing', async () => {
  const { message, event, log } = setup(new Set(['engine']))
  await message({ sessionID: 'p' }, output('p', 'review the branch'))
  await event({ event: { type: 'session.created', properties: { info: { id: 'c', parentID: 'p' } } } })
  const first = output('c', 'look at the parser')
  await message({ sessionID: 'c', agent: 'general' }, first)
  assert.equal(first.parts.length, 2)
  assert.doesNotMatch(String(first.parts[1]?.['text']), /delegating/)
  assert.equal(String(first.parts[1]?.['text']).split('\n').length, 5)
  assert.match(String(first.parts[1]?.['text']), /brief is only to review: report findings only, change no code and record nothing/)
  const second = output('c', 'review it')
  await message({ sessionID: 'c', agent: 'general' }, second)
  assert.equal(second.parts.length, 1)
  const engine = output('engine', 'review this diff')
  await message({ sessionID: 'engine', agent: 'rust-reviewer' }, engine)
  assert.equal(engine.parts.length, 1)
  assert.deepEqual(log().map(e => [e.session, e.agent]), [['p', undefined], ['p', 'general']])
})

test('a message with nothing to build the part on is logged as unsaid, and bad input never throws', async () => {
  const { message, event, log } = setup()
  const empty = { message: {}, parts: [] }
  await message({ sessionID: 's' }, empty)
  assert.equal(empty.parts.length, 0)
  const odd = { message: {}, parts: [{ type: 'text', text: 'review it' }] }
  await message({ sessionID: 's' }, odd)
  assert.equal(odd.parts.length, 1)
  assert.equal(log().at(-1)?.silent, 'no-part')
  await message({ sessionID: 's' }, null)
  await event({ event: null })
})
