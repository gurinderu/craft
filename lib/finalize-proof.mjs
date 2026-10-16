// The proof that a finalize already filed a record from a run directory (realm @nick/craft, node #245).
//
// The logger call is retried when its agent dies, and an agent can die AFTER the script ran: the
// record is filed and the run directory folded and removed. Refiling a record that left its ledger to
// the shards would then file an empty ledger as the newest round. A vanished directory does not prove a
// retry — a sibling's fold or a `recover` removes one before a first finalize too — so the first
// finalize leaves a proof: the record it filed and the hash of the payload it was given. A retry sends
// the same payload, so only an equal hash whose record still exists is a retry.
//
// Proofs live in `<store>/.finalize-proofs/<run-dir basename>`, outside `.partial`, so `recover` and
// the rejoin search never see them; each write prunes proofs older than a week, far past any retry.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { leavesLedgerToShards } from './ledger-in-shards.mjs'

const PROOF_DIR = '.finalize-proofs'
const PROOF_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** @param {unknown} record */
function payloadHash(record) {
  return crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex')
}

// Only a run directory directly under the store's `.partial` names a proof.
/** @param {string} store @param {string} dir @returns {string} */
function proofFile(store, dir) {
  if (!dir || path.resolve(path.dirname(dir)) !== path.resolve(store, '.partial')) return ''
  return path.join(store, PROOF_DIR, path.basename(dir))
}

// The record an identical payload already filed from this run directory, '' when none is proven.
/** @param {Record<string, unknown>} record @param {{ store: string, dir: string }} at @returns {string} */
export function filedBefore(record, { store, dir }) {
  const proof = leavesLedgerToShards(record) ? proofFile(store, dir) : ''
  if (!proof || !fs.existsSync(proof)) return ''
  try {
    const p = JSON.parse(fs.readFileSync(proof, 'utf8'))
    const file = path.join(store, path.basename(String(p.file)))
    return p.hash === payloadHash(record) && fs.existsSync(file) ? file : ''
  } catch {
    return ''
  }
}

// Leave the proof for a record that left its ledger to the shards. Best-effort: a proof that cannot be
// written costs only the retry's recognition, never the record already on disk.
/** @param {Record<string, unknown>} record @param {{ store: string, dir: string, file: string }} at */
export function leaveFinalizeProof(record, { store, dir, file }) {
  const proof = leavesLedgerToShards(record) ? proofFile(store, dir) : ''
  if (!proof) return
  try {
    fs.mkdirSync(path.dirname(proof), { recursive: true })
    pruneProofs(path.dirname(proof))
    fs.writeFileSync(proof, JSON.stringify({ file: path.basename(file), hash: payloadHash(record) }))
  } catch { /* see above */ }
}

/** @param {string} root */
function pruneProofs(root) {
  const cutoff = Date.now() - PROOF_MAX_AGE_MS
  for (const name of fs.readdirSync(root)) {
    const f = path.join(root, name)
    try {
      if (fs.statSync(f).mtimeMs < cutoff) fs.rmSync(f, { force: true })
    } catch { /* gone already */ }
  }
}
