// Recoverable detail/index/proof publication (realm @nick/craft, nodes #555, #556, #559).
// Callers hold the shared index lock for planning, replay and publication.
import fs from 'node:fs'
import path from 'node:path'
import { parseJsonObject } from './json-object.mjs'

/** @typedef {{ key: string, file: string, warnings: string[] }} FilingProof */
/** @typedef {{ file: string, before: string | null, record: string, proofs: FilingProof[], finalizing?: string }} FilingIntent */
/** @typedef {{ detail: string, intent: string }} Retained */
const INTENTS = '.filing-intents'

/** @param {string} file */
export function syncFilingPath(file) {
  const directory = fs.statSync(file).isDirectory()
  // Windows has no directory-fsync contract here; replay covers process crashes, not power loss.
  if (directory && process.platform === 'win32') return
  const fd = fs.openSync(file, directory ? 'r' : 'r+')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

/** @param {string} file @param {string} text @param {boolean} [replace] */
export function publishVerified(file, text, replace = true) {
  const root = path.dirname(file)
  const stage = fs.mkdtempSync(path.join(root, '.filing-stage-'))
  const tmp = path.join(stage, path.basename(file))
  try {
    fs.writeFileSync(tmp, text, { flag: 'wx' })
    syncFilingPath(tmp)
    if (fs.readFileSync(tmp, 'utf8') !== text) throw new Error(`readback disagrees: ${file}`)
    if (replace) fs.renameSync(tmp, file)
    else fs.linkSync(tmp, file)
    syncFilingPath(root)
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }
}

/** @param {string} file @returns {string | null} */
function current(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return null
    throw e
  }
}

/**
 * The words of a retained conflict: which detail, which intent, and how to clear it.
 * @param {string} detail @param {string} intent
 */
const conflict = (detail, intent) =>
  `filing conflict: ${detail} is not what intent ${intent} expected; intent retained, the detail left as it is — its record may be the run's only copy: to keep it, move the detail aside and \`jq -j .record <intent> > <detail>\`, and the next write completes the intent; to keep the detail, save that record elsewhere, then delete the intent`

/** Retained intents already warned of in this process. @type {Set<string>} */
const warned = new Set()

/**
 * Replays `intent`; false when its detail holds a newer write, left untouched.
 * @param {string} store @param {FilingIntent} intent @param {(record: Record<string, unknown>) => void} index
 */
function replay(store, intent, index) {
  if (path.basename(intent.file) !== intent.file) throw new Error('invalid filing intent filename')
  const file = path.join(store, intent.file)
  markFinalizing(store, intent.finalizing)
  const now = current(file)
  if (now !== intent.record) {
    if (now !== intent.before) return false
    publishVerified(file, intent.record, intent.before !== null)
  }
  index(parseJsonObject(intent.record))
  syncFilingPath(path.join(store, 'index.jsonl'))
  syncFilingPath(store)
  for (const proof of intent.proofs) {
    if (path.basename(proof.key) !== proof.key) throw new Error('invalid filing proof key')
    const root = path.join(store, '.finalize-proofs')
    fs.mkdirSync(root, { recursive: true })
    publishVerified(path.join(root, proof.key), JSON.stringify(proof))
    syncFilingPath(store)
  }
  return true
}

/** @param {string} store @param {string | undefined} dir */
function markFinalizing(store, dir) {
  if (!dir) return
  const relative = path.relative(path.resolve(store, '.partial'), path.resolve(dir))
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('invalid finalizing directory')
  if (!fs.existsSync(dir)) return
  const marker = path.join(dir, '.finalized')
  fs.writeFileSync(marker, `${new Date().toISOString()}\n`)
  syncFilingPath(marker)
  syncFilingPath(dir)
}

/**
 * Replays every pending intent; a conflicting one is retained and skipped, so it never blocks a write to another
 * detail — returned for `sayRetained`, and a write to its own detail refuses in `commitFiling`.
 * @param {string} store @param {(record: Record<string, unknown>) => void} index @returns {Retained[]}
 */
export function recoverFilings(store, index) {
  const root = path.join(store, INTENTS)
  if (!fs.existsSync(root)) return []
  /** @type {Retained[]} */
  const retained = []
  for (const name of fs
    .readdirSync(root)
    .filter(n => n.endsWith('.json'))
    .sort()) {
    const file = path.join(root, name)
    const intent = /** @type {FilingIntent} */ (/** @type {unknown} */ (parseJsonObject(fs.readFileSync(file, 'utf8'))))
    if (!replay(store, intent, index)) {
      retained.push({ detail: path.join(store, intent.file), intent: file })
      continue
    }
    fs.unlinkSync(file)
    syncFilingPath(root)
  }
  return retained
}

/**
 * Warns on stderr, once per process, of each retained intent but the one on `target` (a detail's base name), whose
 * own write refused with the conflict instead.
 * @param {Retained[]} retained @param {string} [target]
 */
export function sayRetained(retained, target = '') {
  for (const r of retained) {
    if (path.basename(r.detail) === target || warned.has(r.intent)) continue
    warned.add(r.intent)
    process.stderr.write(`craft-log-run WARNING: ${conflict(r.detail, r.intent)} — this write went on\n`)
  }
}

/** @param {string} store @param {FilingIntent} intent @param {(record: Record<string, unknown>) => void} index */
export function commitFiling(store, intent, index) {
  const root = path.join(store, INTENTS)
  fs.mkdirSync(root, { recursive: true })
  syncFilingPath(store)
  const file = path.join(root, intent.file)
  // Under the lock, after `recoverFilings`: an intent still here is a retained conflict on this detail.
  const refused = () => new Error(conflict(path.join(store, intent.file), file))
  if (fs.existsSync(file)) throw refused()
  publishVerified(file, JSON.stringify(intent), false)
  if (!replay(store, intent, index)) throw refused()
  fs.unlinkSync(file)
  syncFilingPath(root)
}
