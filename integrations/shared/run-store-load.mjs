// The run store's detail records read in one pass, for integrations/shared/match-external-findings-cli.mjs. The run-store
// report the retired analyze-runs.mjs printed beside this loader is the binary's now: `craft runs retro`, `craft runs hooks` and `craft runs round-pairs`
// (cli/bin/craft/src/runs.rs; realm @nick/craft, #540, #562), its figures frozen in content/parity/retro-cases.json.
import { parseJsonObject } from './json-object.mjs'
import fs from 'node:fs'
import path from 'node:path'

/** @typedef {import('./run-record.mjs').RunRecord} RunRec */

/**
 * The store's records, or null when it does not exist; a store that exists but cannot be listed (an ancestor
 * the user cannot search, not a directory) throws: a degraded read must not read as an empty store. A record
 * that does not parse is a run whose telemetry is gone, named in `unreadable` rather than dropped.
 * @param {string} dir @returns {{ records: RunRec[], unreadable: Array<{ file: string, reason: string }> } | null}
 */
export function loadRecords(dir) {
  let files
  try {
    files = fs.readdirSync(dir)
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return null
    throw e
  }
  /** @type {RunRec[]} */
  const records = []
  /** @type {Array<{ file: string, reason: string }>} */
  const unreadable = []
  for (const f of files) {
    if (!f.endsWith('.json')) continue // skips index.jsonl and README.md
    try {
      records.push(parseJsonObject(fs.readFileSync(path.join(dir, f), 'utf8')))
    } catch (e) {
      unreadable.push({ file: f, reason: String((e && /** @type {Error} */ (e).message) || e).slice(0, 80) })
    }
  }
  return { records, unreadable }
}
