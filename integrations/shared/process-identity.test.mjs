import { afterEach, test, vi } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { processIdentity, ticketIdentity } from './process-identity.mjs'
import { withIndexTurn, TURNS } from './index-turn.mjs'

/** @type {string[]} */
const made = []
afterEach(() => {
  vi.restoreAllMocks()
  made.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true }))
})
const deadline = () => performance.now() + 1000
function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-identity-'))
  made.push(dir)
  fs.mkdirSync(path.join(dir, TURNS))
  return dir
}
const nonce = '0'.repeat(24)

test('same native identity is stable; name parser accepts only canonical fixed-width fields', () => {
  const identity = processIdentity(process.pid, deadline())
  assert.match(identity ?? '', /^v1_[0-9a-f]{32}_[0-9a-f]{16}$/)
  assert.equal(identity, processIdentity(process.pid, deadline()))
  const name = `${process.pid}-${identity}-${nonce}`
  assert.deepEqual(ticketIdentity(name), { pid: process.pid, identity })
  for (const bad of [name + '0', name + '\n', name.slice(0, -1), '0-' + name, '4294967296-' + name.split('-').slice(1).join('-'), `${process.pid}-old`])
    assert.throws(() => ticketIdentity(bad), /invalid/)
})

test('previous boot bypasses inaccessible PID; same boot errors and malformed names refuse and retain foreign paths', () => {
  const dir = store()
  const identity = processIdentity(process.pid, deadline())
  assert.ok(identity)
  const old = identity.replace(identity.slice(3, 35), identity.slice(3, 35) === '0'.repeat(32) ? '1'.repeat(32) : '0'.repeat(32))
  const peer = path.join(dir, TURNS, `42-${old}-${nonce}`)
  fs.mkdirSync(peer)
  const read = fs.readFileSync
  vi.spyOn(fs, 'readFileSync').mockImplementation((file, options) => {
    if (file === '/proc/42/stat') throw Object.assign(new Error('inaccessible'), { code: 'EACCES' })
    return read(file, options)
  })
  const options = { timeoutMs: 100, waitMs: 2 }
  assert.equal(
    withIndexTurn(dir, () => true, options),
    true,
  )
  fs.renameSync(peer, path.join(dir, TURNS, `42-${identity}-${nonce}`))
  assert.throws(() => withIndexTurn(dir, () => assert.fail('entered'), options), /inaccessible/)
  fs.renameSync(path.join(dir, TURNS, `42-${identity}-${nonce}`), path.join(dir, TURNS, 'malformed'))
  assert.throws(() => withIndexTurn(dir, () => assert.fail('entered'), options), /invalid index writer ticket/)
  assert.deepEqual(fs.readdirSync(path.join(dir, TURNS)), ['malformed'])
})

test('Linux stat accepts embedded parentheses and u64 max, refuses parse/permission failures and hidden proc entries', () => {
  const read = fs.readFileSync
  const prefix = `${process.pid} (name ) with spaces) S ${'0 '.repeat(18)}`
  let text = `${prefix}18446744073709551615 0`
  vi.spyOn(fs, 'readFileSync').mockImplementation((file, options) => (file === `/proc/${process.pid}/stat` ? text : read(file, options)))
  assert.ok(processIdentity(process.pid, deadline())?.endsWith('_ffffffffffffffff'))
  for (const ticks of ['18446744073709551616', '01', '-1', 'x', '']) {
    text = prefix + ticks
    assert.throws(() => processIdentity(process.pid, deadline()), /invalid process stat/)
  }
  vi.restoreAllMocks()
  for (const code of ['EACCES', 'ENOENT']) {
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((file, options) => {
      if (file === `/proc/${process.pid}/stat`) throw Object.assign(new Error(code), { code })
      return read(file, options)
    })
    assert.throws(() => processIdentity(process.pid, deadline()), new RegExp(code))
    spy.mockRestore()
  }
})

test('current PID with stale incarnation is ignored without deleting its ticket', () => {
  const dir = store()
  const identity = processIdentity(process.pid, deadline())
  assert.ok(identity)
  const stale = identity.slice(0, 36) + (identity.endsWith('0'.repeat(16)) ? '1'.repeat(16) : '0'.repeat(16))
  const name = `${process.pid}-${stale}-${nonce}`
  fs.mkdirSync(path.join(dir, TURNS, name))
  assert.equal(
    withIndexTurn(dir, () => true, { timeoutMs: 100, waitMs: 2 }),
    true,
  )
  assert.deepEqual(fs.readdirSync(path.join(dir, TURNS)), [name])
})
