import { afterEach, test, vi } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { withIndexTurn, TURNS } from './index-turn.mjs'
import { processIdentity } from './process-identity.mjs'

const platform = process.platform
const identity = `v1_${'a'.repeat(32)}_${'0'.repeat(15)}1`
/** @type {string[]} */
const made = []
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform })
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  made.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true }))
})

/** @param {string} body */
function fixture(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-helper-'))
  made.push(dir)
  const bin = path.join(dir, 'craft')
  fs.writeFileSync(bin, `#!${process.execPath}\n${body}`, { mode: 0o755 })
  vi.stubEnv('CRAFT_BIN', bin)
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  return dir
}
const reply = `JSON.stringify({version:1,pid:Number(process.argv.at(-1)),identity:${JSON.stringify(identity)}})`

for (const size of [1023, 1024, 1025]) {
  test(`native helper stdout limit ${size}/1024 bytes`, () => {
    fixture(`process.stdout.write(${reply}.padEnd(${size},' '))`)
    const run = () => processIdentity(process.pid, performance.now() + 2000)
    if (size <= 1024) assert.equal(run(), identity)
    else assert.throws(run, /ENOBUFS/)
  })
}

for (const response of [
  '',
  'null',
  '[]',
  '{}',
  '{"version":2,"pid":PID,"identity":null}',
  '{"version":1,"pid":0,"identity":null}',
  '{"version":1,"pid":"PID","identity":null}',
  '{"version":1,"pid":PID,"identity":"v1_bad"}',
  '{"version":1,"pid":PID,"identity":null,"extra":1}',
  '{"version":1,"pid":PID,"identity":null}\n{}',
  '{"version":1,"pid":PID,"identity":null}',
  JSON.stringify({ version: 1, pid: process.pid, identity: identity + '\n' }),
]) {
  test(`malformed or incompatible helper response refuses: ${response}`, () => {
    const dir = fixture(`process.stdout.write(${JSON.stringify(response.replaceAll('PID', String(process.pid)))})`)
    const query = () => processIdentity(process.pid, performance.now() + 2000)
    if (response === '{"version":1,"pid":PID,"identity":null}') assert.equal(query(), null)
    else assert.throws(query)
    assert.throws(() => withIndexTurn(dir, () => true, { timeoutMs: 2000, waitMs: 2 }))
    assert.equal(fs.existsSync(path.join(dir, TURNS)), false, 'no choosing announcement without self identity')
  })
}

test('absent helper, old binary and explicit native error refuse, preserving stderr', () => {
  const dir = fixture('process.stderr.write("native permission denied");process.exit(1)')
  const run = () => withIndexTurn(dir, () => assert.fail('entered'), { timeoutMs: 1000, waitMs: 2 })
  assert.throws(run, /native permission denied/)
  vi.stubEnv('CRAFT_BIN', process.execPath)
  assert.throws(run, /Cannot find module/)
  vi.stubEnv('CRAFT_BIN', path.join(dir, 'missing'))
  assert.throws(run, /requires the cached craft binary/)
  assert.equal(fs.existsSync(path.join(dir, TURNS)), false)
})

test('helper timeout kills a stuck process and never disables timeout on a sub-millisecond remainder', () => {
  const dir = fixture('process.on("SIGTERM",()=>{});setInterval(()=>{},1000)')
  const start = performance.now()
  assert.throws(() => withIndexTurn(dir, () => assert.fail('entered'), { timeoutMs: 100, waitMs: 2 }), /ETIMEDOUT/)
  assert.ok(performance.now() - start < 2000)
  assert.equal(fs.existsSync(path.join(dir, TURNS)), false)
  vi.spyOn(performance, 'now').mockReturnValue(0)
  assert.throws(() => processIdentity(process.pid, 0.5), /deadline/)
  assert.throws(() => processIdentity(process.pid, 1), /ETIMEDOUT/)
  assert.throws(() => processIdentity(process.pid, 0), /deadline/)
})

// The clock reads 0 before the spawn, so the helper's real timeout is the whole
// deadline: wide enough that a loaded machine still answers in time. Only the
// mocked reading after the reply decides the outcome, never the wall clock.
const DEADLINE = 60_000
for (const offset of [-1, 0, 1]) {
  test(`helper response arriving at deadline${offset < 0 ? '' : '+'}${offset}ms is checked against original deadline`, () => {
    fixture(`process.stdout.write(${reply})`)
    let calls = 0
    vi.spyOn(performance, 'now').mockImplementation(() => (++calls <= 2 ? 0 : DEADLINE + offset))
    const run = () => processIdentity(process.pid, DEADLINE)
    if (offset < 0) assert.equal(run(), identity)
    else assert.throws(run, /admission deadline\)/)
  })
}

test('peer lookup failure cleans own published ticket only; old boot never invokes failing peer lookup', () => {
  const dir = fixture(
    `if(Number(process.argv.at(-1))!==${process.pid}){process.stderr.write('peer inaccessible');process.exit(1)} process.stdout.write(${reply})`,
  )
  const root = path.join(dir, TURNS)
  const name = `42-${identity}-${'0'.repeat(24)}`
  fs.mkdirSync(path.join(root, name), { recursive: true })
  const run = () => withIndexTurn(dir, () => true, { timeoutMs: 2000, waitMs: 2 })
  assert.throws(run, /peer inaccessible/)
  assert.deepEqual(fs.readdirSync(root), [name])
  const old = name.replace('a'.repeat(32), 'b'.repeat(32))
  fs.renameSync(path.join(root, name), path.join(root, old))
  assert.equal(run(), true)
  assert.deepEqual(fs.readdirSync(root), [old])
})
