// The mark a finding carries when the memory judges found its code going against an active record (realm
// @nick/craft, nodes #270, #282, #423): read by triage-findings' sift (lib/triage-sift.mjs) and by the marking
// itself (lib/memory-contradiction.mjs). The sorting before publication that read it here is the craft binary's now
// (cli/crates/craft-review/src/publish/sort.rs).

/**
 * @typedef {{ severity?: unknown, title?: unknown, why?: unknown, fix?: unknown, file?: unknown, line?: unknown,
 *   tier?: unknown, source?: unknown, sources?: unknown, toolRule?: unknown, priorDecision?: unknown, [k: string]: unknown }} SortableFinding
 */

/**
 * The record a finding was marked as going against — its id, kind and the judge's why — or null when it
 * carries no well-formed mark (realm @nick/craft, node #282). @param {SortableFinding} f
 * @returns {{ id: string, kind: string, why: string } | null}
 */
export function contradictionOf(f) {
  const m = f['memoryContradicts']
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null
  const o = /** @type {Record<string, unknown>} */ (m)
  return typeof o['id'] === 'string' && o['id'] ? { id: o['id'], kind: String(o['kind'] ?? ''), why: String(o['why'] ?? '') } : null
}
