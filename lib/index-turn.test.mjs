import { afterEach, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { performance } from 'node:perf_hooks'
import { randomBytes } from 'node:crypto'
import { processIdentity } from './process-identity.mjs'
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
/** @param {number} pid */
const name = pid => `${pid}-${processIdentity(pid, performance.now() + 1000)}-${randomBytes(12).toString('hex')}`

test('a live chooser blocks even without its number, then its removal permits entry', () => {
  const store = tmp()
  const peer = path.join(store, TURNS, name(process.pid))
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
  const peer = path.join(store, TURNS, name(process.pid))
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
  assert.ok(child.pid)
  const peer = path.join(store, TURNS, name(child.pid))
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

test('a killed writer ticket must not revive when its PID is reassigned to a live process', async () => {
  const store = tmp()
  const module = new URL('./index-turn.mjs', import.meta.url).href
  const launch = () =>
    spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    import { withIndexTurn } from ${JSON.stringify(module)};
    withIndexTurn(process.env.STORE, () => {
      process.stdout.write('ready');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
    }, { timeoutMs: 1000, waitMs: 2 });
  `,
      ],
      { env: { ...process.env, STORE: store } },
    )
  let child = launch()
  let exited = once(child, 'exit')
  try {
    const own = processIdentity(process.pid, performance.now() + 1000)
    for (let attempt = 0; ; attempt++) {
      await once(child.stdout, 'data')
      assert.ok(child.pid)
      if (processIdentity(child.pid, performance.now() + 1000) !== own) break
      assert.ok(attempt < 9, 'could not construct distinct starttime tokens after ten child processes')
      child.kill('SIGKILL')
      await exited
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
      child = launch()
      exited = once(child, 'exit')
    }
    const root = path.join(store, TURNS)
    const original = fs.readdirSync(root).find(name => name.startsWith(`${child.pid}-`))
    assert.ok(original)
    assert.notEqual(original.split('-')[1], processIdentity(process.pid, performance.now() + 1000), 'simulated replacement has a different incarnation')
    child.kill('SIGKILL')
    await exited
    // Real death, simulated PID reuse: retain every other byte of the owner's identity.
    const reused = `${process.pid}-${original.slice(original.indexOf('-') + 1)}`
    fs.renameSync(path.join(root, original), path.join(root, reused))
    assert.equal(fs.existsSync(path.join(store, 'index.jsonl.lock')), false)
    assert.equal(
      withIndexTurn(store, () => 'entered', opts),
      'entered',
    )
    assert.ok(fs.existsSync(path.join(root, reused)))
  } finally {
    child.kill('SIGKILL')
    await exited
  }
})
