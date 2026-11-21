// Every writer of index.jsonl takes one lock (realm @nick/craft, node #401): an append that arrives while a
// rewrite holds the index waits, and lands after it rather than being lost.
import { test, afterEach } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { LOCK, STALE_MS, TIMEOUT_MS, appendIndexLine, withIndexLock } from './index-lock.mjs'
import { TURNS } from './index-turn.mjs'

/** @type {string[]} */
const made = []
afterEach(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-index-lock-'))
  made.push(d)
  return d
}

/** @param {number} ms */
const busy = ms => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    /* hold the lock */
  }
}

test('an append from another process during a rewrite waits for it and is not lost', async () => {
  const store = tmp()
  const index = path.join(store, 'index.jsonl')
  fs.writeFileSync(index, '{"n":1}\n')
  const mod = pathToFileURL(path.resolve('integrations/shared/index-lock.mjs')).href
  /** @type {Promise<number | null>} */
  let exited = Promise.resolve(null)
  withIndexLock(store, () => {
    const lines = fs.readFileSync(index, 'utf8')
    const child = spawn(process.execPath, [
      '--input-type=module',
      '-e',
      `import { appendIndexLine } from ${JSON.stringify(mod)}; appendIndexLine(${JSON.stringify(store)}, '{"n":2}')`,
    ])
    exited = new Promise(resolve => child.on('exit', resolve))
    busy(1500) // the child is up and trying to append now
    fs.writeFileSync(`${index}.tmp`, lines.replace('{"n":1}', '{"n":1,"rewritten":true}'))
    fs.renameSync(`${index}.tmp`, index)
  })
  assert.equal(await exited, 0)
  assert.deepEqual(fs.readFileSync(index, 'utf8').split('\n').filter(Boolean), ['{"n":1,"rewritten":true}', '{"n":2}'])
  assert.equal(fs.existsSync(path.join(store, 'index.jsonl.lock')), false, 'released')
})

test('a stale lock left by a dead writer is taken over; a live one makes the writer give up after the timeout', () => {
  const store = tmp()
  const lock = path.join(store, 'index.jsonl.lock')
  fs.writeFileSync(lock, '1\n')
  const old = new Date(Date.now() - 60_000)
  fs.utimesSync(lock, old, old)
  appendIndexLine(store, '{"n":1}')
  assert.equal(fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8'), '{"n":1}\n')
  fs.writeFileSync(lock, '1\n')
  assert.throws(() => withIndexLock(store, () => 0, { timeoutMs: 100 }), /stays locked: held by another writer/)
  assert.ok(fs.existsSync(lock), "another writer's live lock is left alone")
})

test('the lock is released when the work throws', () => {
  const store = tmp()
  assert.throws(
    () =>
      withIndexLock(store, () => {
        throw new Error('boom')
      }),
    /boom/,
  )
  assert.equal(fs.existsSync(path.join(store, 'index.jsonl.lock')), false)
})

test('a stale lock the writer cannot remove ends in an error naming why, within the timeout', () => {
  const store = tmp()
  const lock = path.join(store, 'index.jsonl.lock')
  fs.writeFileSync(lock, '1\n')
  const old = new Date(Date.now() - 60_000)
  fs.utimesSync(lock, old, old)
  fs.mkdirSync(path.join(store, '.index-writers'))
  fs.chmodSync(store, 0o555)
  const t0 = Date.now()
  try {
    assert.throws(() => withIndexLock(store, () => 0, { timeoutMs: 300 }), /the stale lock could not be removed \((EACCES|EPERM)\)/)
  } finally {
    fs.chmodSync(store, 0o755)
  }
  assert.ok(Date.now() - t0 < 3000, 'gave up at its deadline instead of spinning')
})

test('two writers taking over one stale lock at once both write, one after the other', async () => {
  const store = tmp()
  const lock = path.join(store, 'index.jsonl.lock')
  fs.writeFileSync(lock, 'dead\n')
  const old = new Date(Date.now() - 60_000)
  fs.utimesSync(lock, old, old)
  const mod = pathToFileURL(path.resolve('integrations/shared/index-lock.mjs')).href
  const index = path.join(store, 'index.jsonl')
  const body = (/** @type {string} */ who) => `import fs from 'node:fs'; import { withIndexLock } from ${JSON.stringify(mod)};
    withIndexLock(${JSON.stringify(store)}, () => {
      fs.appendFileSync(${JSON.stringify(index)}, '${who} in\\n')
      const end = Date.now() + 300; while (Date.now() < end) {}
      fs.appendFileSync(${JSON.stringify(index)}, '${who} out\\n')
    })`
  const runs = ['a', 'b'].map(who => new Promise(resolve => spawn(process.execPath, ['--input-type=module', '-e', body(who)]).on('exit', resolve)))
  assert.deepEqual(await Promise.all(runs), [0, 0])
  const lines = fs.readFileSync(index, 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 4)
  assert.deepEqual(
    [lines[0]?.split(' ')[1], lines[1]?.split(' ')[1], lines[2]?.split(' ')[1], lines[3]?.split(' ')[1]],
    ['in', 'out', 'in', 'out'],
    'never both inside',
  )
  assert.equal(lines[0]?.split(' ')[0], lines[1]?.split(' ')[0])
  assert.equal(fs.existsSync(lock), false)
  assert.deepEqual(
    fs.readdirSync(store).filter(f => f.includes('.stale-')),
    [],
    'nothing left aside',
  )
})

test('three writers never expire a live writer while recovering a stale lock', async () => {
  const store = tmp()
  const lock = path.join(store, LOCK)
  fs.writeFileSync(lock, 'dead')
  fs.utimesSync(lock, new Date(0), new Date(0))
  const mod = pathToFileURL(path.resolve('integrations/shared/index-lock.mjs')).href
  const body = (/** @type {string} */ who) => `import fs from 'node:fs'; import { withIndexLock } from ${JSON.stringify(mod)};
    withIndexLock(${JSON.stringify(store)}, () => {
      fs.appendFileSync(${JSON.stringify(path.join(store, 'events'))}, '${who} in\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      fs.appendFileSync(${JSON.stringify(path.join(store, 'events'))}, '${who} out\\n');
    }, {staleMs: 10, waitMs: 2, timeoutMs: 5000})`
  const runs = ['a', 'b', 'c'].map(who => new Promise(resolve => spawn(process.execPath, ['--input-type=module', '-e', body(who)]).on('exit', resolve)))
  assert.deepEqual(await Promise.all(runs), [0, 0, 0])
  const events = fs.readFileSync(path.join(store, 'events'), 'utf8').trim().split('\n')
  assert.equal(events.length, 6)
  for (let i = 0; i < events.length; i += 2) assert.equal(events[i + 1], events[i]?.replace(' in', ' out'))
})

// The protocol is one across both writers: the Rust writer (cli/crates/craft-store/src/lock.rs) asserts the same file.
test('the lock is the protocol the shared parity file names, released only while it holds its own token', () => {
  /** @type {{ lockFile: string, staleMs: number, timeoutMs: number, admissionDirectory: string }} */
  const want = JSON.parse(fs.readFileSync(new URL('../../content/parity/lock-protocol.json', import.meta.url), 'utf8'))
  assert.deepEqual([LOCK, STALE_MS, TIMEOUT_MS], [want.lockFile, want.staleMs, want.timeoutMs])
  assert.equal(TURNS, want.admissionDirectory)
  const store = tmp()
  withIndexLock(store, () => fs.writeFileSync(path.join(store, LOCK), 'another writer'))
  assert.equal(fs.readFileSync(path.join(store, LOCK), 'utf8'), 'another writer', "another writer's lock stays")
})
