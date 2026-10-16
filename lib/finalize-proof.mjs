// The proof that a store write already filed a record (realm @nick/craft, nodes #245, #246).
//
// The logger call is re-dispatched when its agent dies or returns no structured answer, and an agent
// can do either AFTER the script ran: the record is filed (and, on finalize, the run directory folded
// and removed). A second filing would count the run twice — or, for a record that left its ledger to
// the shards, file an empty ledger as the newest round. A vanished directory does not prove a retry —
// a sibling's fold or a `recover` removes one before a first finalize too — so every `write` and
// `finalize` leaves a proof: the record it filed, under a key hashed from what a re-dispatch sends
// again. Only an equal key whose record still exists is a retry.
//
// Every filing LEAVES a proof, but the store CHECKS one only for a filing that is a re-dispatch: the
// engine says so with `--retry`, and a finalize of a record that left its ledger to the shards is
// checked without it (review's own re-dispatch after a dead agent sends no flag). Two genuine runs
// with one payload — a refusal stub, say — are two records.
//
// Proofs live in `<store>/.finalize-proofs/<key>`, outside `.partial`, so `recover` and the rejoin
// search never see them. A proof is checked one of two ways:
//   - a `--retry` by (payload, `--dir`, project), for an hour: a re-dispatch comes within the same run,
//     minutes later. Not by session: whether two logger agents of one run share
//     `$CLAUDE_CODE_SESSION_ID` is not observed (it is unset in their shells today), and a key that
//     missed would file the record twice and call it success;
//   - a finalize that left its ledger to the shards by (payload, run directory) alone, for a week, as
//     #245 had it: the directory is unique to its run, and a resumed run finalizes under a NEW session.
// Each write prunes the proofs past the longer window.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const PROOF_DIR = '.finalize-proofs'
const RETRY_MAX_AGE_MS = 60 * 60 * 1000
const DIR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** @typedef {{ store: string, dir?: string, project?: string, session?: string }} ProofAt */
/** @typedef {{ key: string, maxAgeMs: number }} ProofWay */

/** @param {unknown[]} parts */
function hash(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

/** @param {unknown} record @param {ProofAt} at @returns {ProofWay} */
function byRetry(record, { dir = '', project = '' }) {
  return { key: hash([record, dir, project]), maxAgeMs: RETRY_MAX_AGE_MS }
}

// Only a run directory directly under the store's `.partial` names a proof by directory.
/** @param {unknown} record @param {ProofAt} at @returns {ProofWay | null} */
function byRunDir(record, { store, dir = '' }) {
  if (!dir || path.resolve(path.dirname(dir)) !== path.resolve(store, '.partial')) return null
  return { key: `dir-${hash([record, path.basename(dir)])}`, maxAgeMs: DIR_MAX_AGE_MS }
}

// The record an identical filing already put in the store, with the WARNING lines that filing
// printed (a retry repeats them, so the engine still reports them); null when none is proven.
/**
 * @param {Record<string, unknown>} record @param {ProofAt} at
 * @param {{ retry: boolean, runDir: boolean }} ways  which of the two checks apply
 * @returns {{ file: string, warnings: string[] } | null}
 */
export function filedBefore(record, at, ways) {
  const candidates = [ways.retry ? byRetry(record, at) : null, ways.runDir ? byRunDir(record, at) : null]
  for (const way of candidates) {
    const proven = way && readProof(at.store, way)
    if (proven) return proven
  }
  return null
}

/** @param {string} store @param {ProofWay} way @returns {{ file: string, warnings: string[] } | null} */
function readProof(store, { key, maxAgeMs }) {
  const proof = path.join(store, PROOF_DIR, key)
  try {
    if (Date.now() - fs.statSync(proof).mtimeMs > maxAgeMs) return null
    const p = JSON.parse(fs.readFileSync(proof, 'utf8'))
    const file = path.join(store, path.basename(String(p.file)))
    if (p.key !== key || !fs.existsSync(file)) return null
    return { file, warnings: Array.isArray(p.warnings) ? p.warnings.map(String) : [] }
  } catch {
    return null
  }
}

// Leave (or rewrite, once more warnings are known) the proof for a filed record — both ways, when the
// filing names a run directory. Best-effort: a proof that cannot be written costs only the retry's
// recognition, never the record already on disk.
/** @param {Record<string, unknown>} record @param {ProofAt & { file: string, warnings?: string[] }} at */
export function leaveFilingProof(record, at) {
  const root = path.join(at.store, PROOF_DIR)
  const warnings = (at.warnings || []).filter(l => l.startsWith('craft-log-run WARNING'))
  try {
    fs.mkdirSync(root, { recursive: true })
    pruneProofs(root)
    for (const way of [byRetry(record, at), byRunDir(record, at)]) {
      if (way) fs.writeFileSync(path.join(root, way.key), JSON.stringify({ file: path.basename(at.file), key: way.key, warnings }))
    }
  } catch { /* see above */ }
}

/** @param {string} root */
function pruneProofs(root) {
  const cutoff = Date.now() - DIR_MAX_AGE_MS
  for (const name of fs.readdirSync(root)) {
    const f = path.join(root, name)
    try {
      if (fs.statSync(f).mtimeMs < cutoff) fs.rmSync(f, { force: true })
    } catch { /* gone already */ }
  }
}
