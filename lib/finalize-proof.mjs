// The proof that a store write already filed a record (realm @nick/craft, nodes #245, #246).
//
// The logger call is re-dispatched when its agent dies or returns no structured answer, and an agent
// can do either AFTER the script ran: the record is filed (and, on finalize, the run directory folded
// and removed). A second filing would count the run twice — or, for a record that left its ledger to
// the shards, file an empty ledger as the newest round. A vanished directory does not prove a retry —
// a sibling's fold or a `recover` removes one before a first finalize too — so every `write` and
// `finalize` leaves a proof: the record it filed, under a key hashed from what a re-dispatch sends
// again — the payload, `--dir`, the project and the session. Only an equal key whose record still
// exists is a retry. The run directory is in the key, so this keeps the earlier directory-keyed check
// for a record that left its ledger to the shards; the project and session keep two runs elsewhere
// that happen to send byte-identical payloads from being taken for one.
//
// Proofs live in `<store>/.finalize-proofs/<key>`, outside `.partial`, so `recover` and the rejoin
// search never see them. A proof counts for an hour — a re-dispatch comes within the same run, minutes
// later — so two genuine runs sending one stub payload a day apart are not taken for one; each write
// prunes the expired ones.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const PROOF_DIR = '.finalize-proofs'
const PROOF_MAX_AGE_MS = 60 * 60 * 1000

/** @typedef {{ store: string, dir?: string, project?: string, session?: string }} ProofAt */

/** @param {unknown} record @param {ProofAt} at @returns {string} */
function proofKey(record, { dir = '', project = '', session = '' }) {
  return crypto.createHash('sha256').update(JSON.stringify([record, dir, project, session])).digest('hex')
}

/** @param {string} store @param {string} key */
function proofFile(store, key) {
  return path.join(store, PROOF_DIR, key)
}

// The record an identical filing already put in the store, '' when none is proven.
/** @param {Record<string, unknown>} record @param {ProofAt} at @returns {string} */
export function filedBefore(record, at) {
  const key = proofKey(record, at)
  const proof = proofFile(at.store, key)
  try {
    if (Date.now() - fs.statSync(proof).mtimeMs > PROOF_MAX_AGE_MS) return ''
    const p = JSON.parse(fs.readFileSync(proof, 'utf8'))
    const file = path.join(at.store, path.basename(String(p.file)))
    return p.key === key && fs.existsSync(file) ? file : ''
  } catch {
    return ''
  }
}

// Leave the proof for a filed record. Best-effort: a proof that cannot be written costs only the
// retry's recognition, never the record already on disk.
/** @param {Record<string, unknown>} record @param {ProofAt & { file: string }} at */
export function leaveFilingProof(record, at) {
  const key = proofKey(record, at)
  const proof = proofFile(at.store, key)
  try {
    fs.mkdirSync(path.dirname(proof), { recursive: true })
    pruneProofs(path.dirname(proof))
    fs.writeFileSync(proof, JSON.stringify({ file: path.basename(at.file), key }))
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
