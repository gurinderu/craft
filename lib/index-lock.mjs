// One lock for every writer of the store's index.jsonl (realm @nick/craft, node #340). Appends and
// whole-file rewrites (recover replacing a row, finalize replacing recover's row, repair-index) used to
// run unlocked, so an append landing between a rewrite's read and its rename was lost. The lock is a
// file created exclusively beside the index; a lock older than `staleMs` is a writer that died holding
// it and is taken over; waiting is bounded.
import fs from 'node:fs'
import path from 'node:path'

const LOCK = 'index.jsonl.lock'

/** @param {number} ms */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// Removes a lock left by a writer that died holding it; true when it did.
/** @param {string} lock @param {number} staleMs @returns {boolean} */
function clearStale(lock, staleMs) {
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs < staleMs) return false
    fs.rmSync(lock, { force: true })
    return true
  } catch {
    return true   // gone between the failed create and the stat: try again at once
  }
}

/**
 * Runs `fn` holding the store's index lock, and releases it however `fn` ends.
 * @template T
 * @param {string} store @param {() => T} fn
 * @param {{ staleMs?: number, waitMs?: number, timeoutMs?: number }} [opts]
 * @returns {T}
 */
export function withIndexLock(store, fn, { staleMs = 30_000, waitMs = 20, timeoutMs = 10_000 } = {}) {
  fs.mkdirSync(store, { recursive: true })
  const lock = path.join(store, LOCK)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      fs.writeFileSync(lock, `${process.pid}\n`, { flag: 'wx' })
      break
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'EEXIST') throw e
      if (clearStale(lock, staleMs)) continue
      if (Date.now() >= deadline) throw new Error(`index.jsonl stays locked by another writer (${lock}) — retry, or remove the lock if no craft-log-run is running`)
      pause(waitMs)
    }
  }
  try {
    return fn()
  } finally {
    fs.rmSync(lock, { force: true })
  }
}

// One compact line appended to the store's index under its lock.
/** @param {string} store @param {string} line */
export function appendIndexLine(store, line) {
  withIndexLock(store, () => fs.appendFileSync(path.join(store, 'index.jsonl'), `${line}\n`))
}
