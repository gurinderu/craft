import { afterEach, expect, test, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { finalizeRun, writeRecord, writeCheckpoint, findRejoinableDir, recoverPartials } from './craft-log-run.mjs'

/** @type {string[]} */
const dirs = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
function fixture() {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-filing-'))
  dirs.push(store)
  const dir = path.join(store, '.partial', '2026-01-01T00-00-00Z-workflow-review')
  const raw = { kind: 'workflow', name: 'review', verdict: 'Approve' }
  writeCheckpoint(dir, 'detect', raw, { project: '/p' })
  return { raw, opts: { store, dir, project: '/p', observe: false, now: new Date('2026-01-01T00:01:00Z') } }
}
/** @param {string} store */
function details(store) {
  return fs.readdirSync(store).filter(n => n.endsWith('.json'))
}

test('failed replacement index has durable intent and recovery never overwrites a later record', () => {
  const { raw, opts } = fixture()
  const old = writeRecord({ ...raw, verdict: 'Warning' }, opts)
  const rename = fs.renameSync.bind(fs)
  const spy = vi.spyOn(fs, 'renameSync').mockImplementation((a, b) => {
    if (String(b).endsWith('index.jsonl')) throw new Error('index unavailable')
    rename(a, b)
  })
  expect(() => writeRecord(raw, { ...opts, over: old.file })).toThrow('index unavailable')
  expect(fs.existsSync(path.join(opts.store, '.filing-intents'))).toBe(true)
  spy.mockRestore()
  const foreign = { ...old.record, verdict: 'Block', foreign: true }
  fs.writeFileSync(old.file, JSON.stringify(foreign))
  expect(() => writeRecord(raw, opts)).toThrow(/conflict/)
  expect(JSON.parse(fs.readFileSync(old.file, 'utf8'))).toEqual(foreign)
})

test('crash after index before proof is replayed twice without a duplicate', () => {
  const { raw, opts } = fixture()
  const write = fs.writeFileSync.bind(fs)
  const rename = fs.renameSync.bind(fs)
  /** @param {unknown} p */
  const fail = p => {
    if (String(p).includes('.finalize-proofs')) throw new Error('proof unavailable')
  }
  vi.spyOn(fs, 'writeFileSync').mockImplementation((p, ...args) => {
    fail(p)
    write(p, ...args)
  })
  vi.spyOn(fs, 'renameSync').mockImplementation((a, b) => {
    fail(b)
    rename(a, b)
  })
  expect(() => finalizeRun(raw, opts)).toThrow('proof unavailable')
  vi.restoreAllMocks()
  const a = finalizeRun(raw, { ...opts, retry: true })
  const b = finalizeRun(raw, { ...opts, retry: true })
  expect(a.file).toBe(b.file)
  expect(details(opts.store)).toHaveLength(1)
  expect(fs.readFileSync(path.join(opts.store, 'index.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1)
})

test('marker failure refuses before filing even when directory cleanup also fails', () => {
  const { raw, opts } = fixture()
  fs.mkdirSync(path.join(opts.dir, '.finalized'))
  vi.spyOn(fs, 'rmSync').mockImplementation(() => {
    throw new Error('cleanup unavailable')
  })
  expect(() => finalizeRun(raw, opts)).toThrow()
  expect(details(opts.store)).toHaveLength(0)
  expect(findRejoinableDir(raw, opts)).toBe(null)
})

test('readback failure never publishes an orphan record', () => {
  const { raw, opts } = fixture()
  const read = fs.readFileSync.bind(fs)
  vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...args) => {
    if (path.dirname(path.dirname(String(p))) === opts.store && String(p).endsWith('workflow-review.json')) throw new Error('readback unavailable')
    return read(p, ...args)
  })
  expect(() => finalizeRun(raw, opts)).toThrow('readback unavailable')
  expect(details(opts.store)).toHaveLength(0)
  vi.restoreAllMocks()
  const a = finalizeRun(raw, { ...opts, retry: true })
  const b = finalizeRun(raw, { ...opts, retry: true })
  expect(a.file).toBe(b.file)
  expect(details(opts.store)).toHaveLength(1)
})

test('two identical genuine calls without a run directory remain two runs', () => {
  const { raw, opts } = fixture()
  const a = finalizeRun(raw, { ...opts, dir: '' })
  const b = finalizeRun(raw, { ...opts, dir: '' })
  expect(a.file).not.toBe(b.file)
  expect(details(opts.store)).toHaveLength(2)
})

test('partial directory deletion cannot expose a finalized run after removing its marker', () => {
  const { raw, opts } = fixture()
  const remove = fs.rmSync.bind(fs)
  vi.spyOn(fs, 'rmSync').mockImplementation((p, ...args) => {
    if (String(p).includes('.filing-retired-')) {
      remove(path.join(String(p), 'run', '.finalized'))
      throw new Error('cleanup interrupted after marker deletion')
    }
    remove(p, ...args)
  })
  const result = finalizeRun(raw, opts)
  expect(result.unreadable).toContain('cleanup interrupted')
  expect(findRejoinableDir(raw, opts)).toBe(null)
  expect(details(opts.store)).toHaveLength(1)
  expect(finalizeRun(raw, { ...opts, retry: true }).file).toBe(result.file)
})

test('a legacy ordinary claim racing publication is preserved and reported, never unlinked', () => {
  const { raw, opts } = fixture()
  const link = fs.linkSync.bind(fs)
  const other = '{"legacy":"writer"}'
  vi.spyOn(fs, 'linkSync').mockImplementation((a, b) => {
    if (path.dirname(String(b)) === opts.store) fs.writeFileSync(b, other)
    link(a, b)
  })
  expect(() => finalizeRun(raw, opts)).toThrow()
  vi.restoreAllMocks()
  expect(() => finalizeRun(raw, { ...opts, retry: true })).toThrow(/conflict/)
  const files = details(opts.store)
  expect(files).toHaveLength(1)
  expect(fs.readFileSync(path.join(opts.store, String(files[0])), 'utf8')).toBe(other)
})

test('recover replays a pending filing even when its finalized marker excludes checkpoint promotion', () => {
  const { raw, opts } = fixture()
  const index = path.join(opts.store, 'index.jsonl')
  fs.mkdirSync(index)
  expect(() => finalizeRun(raw, opts)).toThrow()
  fs.rmdirSync(index)
  recoverPartials(opts)
  expect(fs.readFileSync(index, 'utf8').trim().split('\n')).toHaveLength(1)
  expect(finalizeRun(raw, { ...opts, retry: true }).already).toBe(true)
  expect(details(opts.store)).toHaveLength(1)
})
