// The one source agent of a run's external sources (lib/review-external-sources.mjs; realm @nick/craft, nodes #430
// and #435): its dispatch, its answer read as the prep's and the discovery's state, each logged, and a nested run's
// prep read as this run's own.
import { SOURCE_PREP_SCHEMA, readDiscovery, readPrep, sameSpec, sourcePrepPrompt, specOf, str } from './external-source-prep.mjs'

/**
 * @typedef {import('./external-source-spec.mjs').ExternalRecord} ExternalRecord
 * @typedef {import('./unit-graph.mjs').PluginPlace} PluginPlace
 * @typedef {import('./external-source-prep.mjs').PrepState} PrepState
 * @typedef {import('./external-source-prep.mjs').DiscoveryState} DiscoveryState
 * @typedef {import('./external-candidate.mjs').RecordLike} RecordLike
 * @typedef {{ raw: unknown } | { why: string }} AgentAnswer
 */

/**
 * The objects of `list`, each read field by field as text (coveredBy), so a malformed one covers nothing.
 * @param {unknown} list @returns {RecordLike[]}
 */
export const asRecords = list => /** @type {RecordLike[]} */ ((Array.isArray(list) ? list : []).filter(x => x && typeof x === 'object' && !Array.isArray(x)))

/**
 * The one agent for what is due — the prep of `records`, the discovery over `over` — its answer, or why it did not run.
 * @param {{ ragent: (prompt: string, opts: object) => Promise<unknown>, plugin: PluginPlace, prepPhase: string }} io
 * @param {ExternalRecord[]} records @param {string[]} over @returns {Promise<AgentAnswer>}
 */
export async function askSourceAgent({ ragent, plugin, prepPhase }, records, over) {
  try {
    return { raw: await ragent(sourcePrepPrompt(records, plugin, over), { label: 'external-sources', phase: prepPhase, schema: SOURCE_PREP_SCHEMA, model: 'haiku', effort: 'low' }) }
  } catch (e) {
    return { why: `the source agent did not run: ${str(e instanceof Error ? e.message : String(e))}` }
  }
}

/** The prep's state from the agent's answer, logged. @param {AgentAnswer} got @param {ExternalRecord[]} records @param {(m: string) => void} logLine @returns {PrepState} */
export function settledPrep(got, records, logLine) {
  const state = 'why' in got ? { ran: true, prepared: [], failed: [], unreachable: got.why } : readPrep(got.raw, records)
  const without = state.unreachable ? records.length : state.failed.length
  logLine(`External sources: ${state.prepared.length} prepared${without ? `, ${without} without context` : ''}`)
  return state
}

/**
 * The discovery's state from the agent's answer over `over`, a candidate `known` covers left out, logged.
 * @param {AgentAnswer} got @param {string[]} over @param {RecordLike[]} known @param {(m: string) => void} logLine @returns {DiscoveryState}
 */
export function settledDiscovery(got, over, known, logLine) {
  const found = 'why' in got ? { ran: true, candidates: [], error: got.why } : readDiscovery(got.raw, over, known)
  logLine(`External candidates: ${found.candidates.length} from ${over.length} touched manifest(s)${found.error ? ` — ${found.error}` : ''}`)
  return found
}

/** The prep's answer per system with the record it answered, as a launcher adopts it; null when no prep ran or the cache was unreachable. @param {PrepState} state @param {ExternalRecord[]} records */
export const prepOutcome = (state, records) => (state.ran && !state.unreachable ? [...state.prepared, ...state.failed].map(e => ({ ...e, ...specOf(records.find(r => r.system === e.system)) })) : null)

/**
 * A nested run's `outcome` read as the prep of `records`: only when it answers every record for the same system,
 * repo, and versionFrom and versionMatch or stated version (sameSpec); each directory is checked again (trustedDir).
 * null when it does not.
 * @param {unknown} systems @param {ExternalRecord[]} records @returns {PrepState | null}
 */
export function adoptedPrep(systems, records) {
  if (!records.length || !Array.isArray(systems)) return null
  /** @param {ExternalRecord} r */
  const answer = r => systems.find(x => sameSpec(x, r))
  return records.every(answer) ? readPrep({ systems: records.map(answer) }, records) : null
}
