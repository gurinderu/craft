import { afterEach, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { TURNS, withIndexTurn } from './index-turn.mjs'

/** @type {string[]} */
const made = []
afterEach(() => made.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })))
function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-index-turn-'))
  made.push(dir)
  fs.mkdirSync(path.join(dir, TURNS))
  return dir
}
const opts = { timeoutMs: 100, waitMs: 2 }

test('a live chooser blocks even without its number, then its removal permits entry', () => {
  const store = tmp()
  const peer = path.join(store, TURNS, `${process.pid}-chooser`)
  fs.mkdirSync(peer)
  assert.throws(() => withIndexTurn(store, () => assert.fail('entered while another chose'), opts), /waiting for writer/)
  assert.deepEqual(fs.readdirSync(path.join(store, TURNS)), [path.basename(peer)], 'failed waiter cleans only its own ticket')
  fs.rmSync(peer, { recursive: true })
  assert.equal(
    withIndexTurn(store, () => 'entered', opts),
    'entered',
  )
})

test('a corrupt live ticket and ticket-number exhaustion refuse rather than entering', () => {
  const store = tmp()
  const peer = path.join(store, TURNS, `${process.pid}-peer`)
  fs.mkdirSync(peer)
  for (const text of ['not-a-number', '0', '9007199254740992']) {
    fs.writeFileSync(path.join(peer, 'number'), text)
    assert.throws(() => withIndexTurn(store, () => assert.fail('entered'), opts), /invalid index writer number/)
  }
  fs.writeFileSync(path.join(peer, 'number'), String(Number.MAX_SAFE_INTEGER))
  assert.throws(() => withIndexTurn(store, () => assert.fail('entered'), opts), /numbers exhausted/)
})

test('tickets of a dead process do not block admission, whether it died choosing or holding', async () => {
  const store = tmp()
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'])
  const exited = new Promise(resolve => child.on('exit', resolve))
  await new Promise(resolve => child.stdout.on('data', resolve))
  const peer = path.join(store, TURNS, `${child.pid}-abandoned`)
  fs.mkdirSync(peer)
  child.kill('SIGKILL')
  await exited
  for (const ticket of [null, '1']) {
    if (ticket) fs.writeFileSync(path.join(peer, 'number'), ticket)
    assert.equal(
      withIndexTurn(store, () => 'entered', opts),
      'entered',
    )
  }
  assert.ok(fs.existsSync(peer), 'no contender deletes another owner’s pathname')
})
