// Admission for local store writers (realm @nick/craft, node #557). Each process writes only its own
// ticket; an abandoned ticket is ignored, never renamed over a live writer's ticket.
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'

export const TURNS = '.index-writers'

/** @param {unknown} error */
const codeOf = error => /** @type {NodeJS.ErrnoException} */ (error).code
/** @param {number} ms */
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** @param {string} name */
function alive(name) {
  const pid = Number(name.split('-')[0])
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`invalid index writer ticket: ${name}`)
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return codeOf(error) !== 'ESRCH'
  }
}

/** @param {string} root @param {string} name @returns {number | null} */
function number(root, name) {
  try {
    const text = fs.readFileSync(path.join(root, name, 'number'), 'utf8')
    const n = Number(text)
    if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(n)) throw new Error(`invalid index writer number: ${name}`)
    return n
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return null
    throw error
  }
}

/** @param {string} root @param {string} self */
function peers(root, self) {
  return fs.readdirSync(root).filter(name => name !== self && alive(name))
}

/** @param {string} root @param {string} peer @param {string} self @param {number} own */
function ahead(root, peer, self, own) {
  if (!fs.existsSync(path.join(root, peer)) || !alive(peer)) return false
  const n = number(root, peer)
  return n === null || n < own || (n === own && peer < self)
}

/**
 * Lamport's bakery doorway: announce choosing before reading the maximum, publish a number,
 * then wait for earlier tickets. A live but suspended writer is waited for, never expired by age.
 * @template T
 * @param {string} store @param {(remainingMs: number) => T} fn
 * @param {{ timeoutMs: number, waitMs: number }} opts
 * @returns {T}
 */
export function withIndexTurn(store, fn, { timeoutMs, waitMs }) {
  const deadline = performance.now() + timeoutMs
  const root = path.join(store, TURNS)
  fs.mkdirSync(root, { recursive: true })
  const self = `${process.pid}-${randomBytes(12).toString('hex')}`
  const dir = path.join(root, self)
  fs.mkdirSync(dir)
  try {
    const maximum = peers(root, self).reduce((max, peer) => Math.max(max, number(root, peer) ?? 0), 0)
    const own = maximum + 1
    if (!Number.isSafeInteger(own)) throw new Error('index writer ticket numbers exhausted')
    // Rename publishes a whole number: another chooser must not read a partially written ticket.
    fs.writeFileSync(path.join(dir, 'choosing'), String(own), { flag: 'wx' })
    fs.renameSync(path.join(dir, 'choosing'), path.join(dir, 'number'))
    for (const peer of peers(root, self)) {
      while (ahead(root, peer, self, own)) {
        if (performance.now() >= deadline) throw new Error(`index.jsonl stays locked: waiting for writer ${peer}`)
        pause(waitMs)
      }
    }
    return fn(Math.max(0, deadline - performance.now()))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
