import { afterEach, test, vi } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { withIndexLock, LOCK } from './index-lock.mjs'
import { withIndexTurn } from './index-turn.mjs'

/** @type {string[]} */
const made = []
afterEach(() => {
  vi.restoreAllMocks()
  made.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true }))
})

for (const step of ['identity', 'preparation', 'scan', 'legacy create']) {
  for (const elapsed of [99, 100, 101]) {
    test(`${step} consumes the same deadline (${elapsed}/100ms); a late create is cleaned`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-budget-'))
      made.push(dir)
      let clock = 0
      vi.spyOn(performance, 'now').mockImplementation(() => clock)
      const read = fs.readFileSync
      vi.spyOn(fs, 'readFileSync').mockImplementation((file, options) => {
        const result = read(file, options)
        if (step === 'identity' && file === `/proc/${process.pid}/stat`) clock = elapsed
        return result
      })
      const mkdir = fs.mkdirSync
      vi.spyOn(fs, 'mkdirSync').mockImplementation((file, options) => {
        const result = mkdir(file, options)
        if (step === 'preparation') clock = elapsed
        return result
      })
      const rename = fs.renameSync
      vi.spyOn(fs, 'renameSync').mockImplementation((a, b) => {
        rename(a, b)
        if (step === 'scan') clock = elapsed
      })
      const write = fs.writeFileSync
      vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
        write(file, data, options)
        if (step === 'legacy create' && file === path.join(dir, LOCK)) clock = elapsed
      })
      let called = false
      const run = () =>
        withIndexLock(
          dir,
          () => {
            called = true
          },
          { timeoutMs: 100, waitMs: 2 },
        )
      if (elapsed < 100) run()
      else assert.throws(run, /deadline/)
      assert.equal(called, elapsed < 100)
      assert.equal(fs.existsSync(path.join(dir, LOCK)), false)
      const turns = path.join(dir, '.index-writers')
      assert.deepEqual(fs.existsSync(turns) ? fs.readdirSync(turns) : [], [])
    })
  }
}

test('zero acquisition budget refuses before any mutation and preserves the foreign lock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-budget-'))
  made.push(dir)
  fs.writeFileSync(path.join(dir, LOCK), 'foreign')
  assert.throws(() => withIndexLock(dir, () => assert.fail('entered'), { timeoutMs: 0 }), /deadline/)
  assert.equal(fs.readFileSync(path.join(dir, LOCK), 'utf8'), 'foreign')
  assert.deepEqual(fs.readdirSync(dir), [LOCK])
})

for (const elapsed of [99, 100, 101]) {
  test(`last empty admission scan returning at ${elapsed}/100ms cannot enter late`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-budget-'))
    made.push(dir)
    let clock = 0
    let scans = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const read = fs.readdirSync
    vi.spyOn(fs, 'readdirSync').mockImplementation((file, options) => {
      const result = read(file, options)
      if (++scans === 2) clock = elapsed
      return result
    })
    let called = false
    const run = () =>
      withIndexTurn(
        dir,
        () => {
          called = true
        },
        { timeoutMs: 100, waitMs: 2 },
      )
    if (elapsed < 100) run()
    else assert.throws(run, /deadline/)
    assert.equal(called, elapsed < 100)
    assert.deepEqual(fs.readdirSync(path.join(dir, '.index-writers')), [])
  })
}
