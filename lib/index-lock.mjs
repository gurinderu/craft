// One lock for every writer of the store's index.jsonl, in both deliveries (realm @nick/craft, node #401).
// Appends and whole-file rewrites (recover replacing a row, finalize replacing recover's row,
// repair-index) used to run unlocked, so an append landing between a rewrite's read and its rename was
// lost. The lock is a file created exclusively beside the index, holding its owner's token. A lock older
// than `staleMs` is a writer that died holding it, and is taken over atomically: renamed aside first, and
// put back if what was renamed turns out to be a fresh lock another writer took in between. Waiting is
// bounded on every path, and longer than the stale age, so a dead holder is outlived rather than waited out.
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

const LOCK = 'index.jsonl.lock'

/** @param {number} ms */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** @param {unknown} e */
const codeOf = e => String(/** @type {NodeJS.ErrnoException} */ (e)?.code ?? e)

// Creates the lock holding `token`; false when another writer holds it.
/** @param {string} lock @param {string} token @returns {boolean} */
function create(lock, token) {
  try {
    fs.writeFileSync(lock, token, { flag: 'wx' })
    return true
  } catch (e) {
    if (codeOf(e) === 'EEXIST') return false
    throw e
  }
}

/** @param {string} file @param {number} staleMs */
function isStale(file, staleMs) {
  return Date.now() - fs.statSync(file).mtimeMs >= staleMs
}

/**
 * Takes over a stale lock: '' when the lock is gone (taken over, or released meanwhile), 'fresh' when it is
 * held, or the error that kept a stale one in place.
 * @param {string} lock @param {number} staleMs @param {string} token @returns {string}
 */
function takeOver(lock, staleMs, token) {
  try {
    if (!isStale(lock, staleMs)) return 'fresh'
  } catch (e) {
    return codeOf(e) === 'ENOENT' ? '' : `stat ${codeOf(e)}`
  }
  const aside = `${lock}.stale-${token}`
  try {
    fs.renameSync(lock, aside)
  } catch (e) {
    return codeOf(e) === 'ENOENT' ? '' : `the stale lock could not be removed (${codeOf(e)})`
  }
  // Between the stat and the rename another writer may have taken the stale lock over and created a fresh
  // one: that is what was renamed, so it goes back where it was (link: never over a lock made since).
  if (!isStale(aside, staleMs)) {
    try { fs.linkSync(aside, lock) } catch { /* a lock exists again: its writer holds the index */ }
    fs.rmSync(aside, { force: true })
    return 'fresh'
  }
  fs.rmSync(aside, { force: true })
  return ''
}

/**
 * Runs `fn` holding the store's index lock, and releases it however `fn` ends.
 * @template T
 * @param {string} store @param {() => T} fn
 * @param {{ staleMs?: number, waitMs?: number, timeoutMs?: number }} [opts]
 * @returns {T}
 */
export function withIndexLock(store, fn, { staleMs = 30_000, waitMs = 20, timeoutMs = 45_000 } = {}) {
  fs.mkdirSync(store, { recursive: true })
  const lock = path.join(store, LOCK)
  const token = `${process.pid}-${randomBytes(6).toString('hex')}`
  const deadline = Date.now() + timeoutMs
  let why = 'held by another writer'
  while (!create(lock, token)) {
    const held = takeOver(lock, staleMs, token)
    if (held && held !== 'fresh') why = held
    if (Date.now() >= deadline) throw new Error(`index.jsonl stays locked: ${why} (${lock}) — retry, or remove the lock if no craft writer is running`)
    if (held) pause(waitMs)
  }
  try {
    return fn()
  } finally {
    release(lock, token)
  }
}

// Removes the lock only while it is still this writer's own.
/** @param {string} lock @param {string} token */
function release(lock, token) {
  try {
    if (fs.readFileSync(lock, 'utf8') === token) fs.rmSync(lock, { force: true })
  } catch { /* already gone */ }
}

// One compact line appended to the store's index under its lock.
/** @param {string} store @param {string} line */
export function appendIndexLine(store, line) {
  withIndexLock(store, () => fs.appendFileSync(path.join(store, 'index.jsonl'), `${line}\n`))
}
