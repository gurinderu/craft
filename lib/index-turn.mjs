// Admission for local store writers (realm @nick/craft, node #557). Each process writes only its own
// ticket; an abandoned ticket is ignored, never renamed over a live writer's ticket.
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { processIdentity, ticketIdentity, remaining } from './process-identity.mjs'

export const TURNS = '.index-writers'

/** @param {unknown} error */
const codeOf = error => /** @type {NodeJS.ErrnoException} */ (error).code
/** @param {number} ms */
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** @param {string} name @param {string} identity @param {number} deadline */
function alive(name, identity, deadline) {
  remaining(deadline)
  const peer = ticketIdentity(name)
  if (peer.identity.slice(0, 35) !== identity.slice(0, 35)) return false
  return processIdentity(peer.pid, deadline) === peer.identity
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

/** @param {string} root @param {string} self @param {string} identity @param {number} deadline */
function peers(root, self, identity, deadline) {
  remaining(deadline)
  return fs.readdirSync(root).filter(name => name !== self && alive(name, identity, deadline))
}

/** @param {string} root @param {string} peer @param {string} self @param {number} own @param {string} identity @param {number} deadline */
function ahead(root, peer, self, own, identity, deadline) {
  if (!fs.existsSync(path.join(root, peer)) || !alive(peer, identity, deadline)) return false
  const n = number(root, peer)
  return n === null || n < own || (n === own && peer < self)
}

/**
 * Lamport's bakery doorway: announce choosing before reading the maximum, publish a number,
 * then wait for earlier tickets. A live but suspended writer is waited for, never expired by age.
 * @template T
 * @param {string} store @param {(deadline: number) => T} fn
 * @param {{ timeoutMs: number, waitMs: number }} opts
 * @returns {T}
 */
export function withIndexTurn(store, fn, { timeoutMs, waitMs }) {
  const deadline = performance.now() + timeoutMs
  const identity = processIdentity(process.pid, deadline)
  if (!identity) throw new Error('could not establish own process identity')
  const root = path.join(store, TURNS)
  fs.mkdirSync(root, { recursive: true })
  const self = `${process.pid}-${identity}-${randomBytes(12).toString('hex')}`
  const dir = path.join(root, self)
  fs.mkdirSync(dir)
  try {
    const maximum = peers(root, self, identity, deadline).reduce((max, peer) => {
      remaining(deadline)
      return Math.max(max, number(root, peer) ?? 0)
    }, 0)
    const own = maximum + 1
    if (!Number.isSafeInteger(own)) throw new Error('index writer ticket numbers exhausted')
    // Rename publishes a whole number: another chooser must not read a partially written ticket.
    fs.writeFileSync(path.join(dir, 'choosing'), String(own), { flag: 'wx' })
    fs.renameSync(path.join(dir, 'choosing'), path.join(dir, 'number'))
    for (const peer of peers(root, self, identity, deadline)) {
      while (ahead(root, peer, self, own, identity, deadline)) {
        pause(Math.min(waitMs, remaining(deadline)))
      }
    }
    remaining(deadline)
    return fn(deadline)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
