// The review's external sources (realm @nick/craft, node #430, the records of node #431): when memory holds an
// `external` record for the diff's paths and the run has a lens that judges another system's behaviour, ONE
// cheap agent prepares their source (lib/external-source-prep.mjs), and the directories it prepared reach those
// lenses and every verifier as an EXTERNAL SOURCES block; the report says what was and was not
// (lib/external-source-text.mjs). This module is the run's kit over both.
import { externalRecords } from './external-source-spec.mjs'
import { SOURCE_PREP_SCHEMA, readPrep, sameSpec, sourcePrepPrompt, specOf, str } from './external-source-prep.mjs'
import { externalSourcesSection, lensSourcesBlock, verifySourcesBlock } from './external-source-text.mjs'

/**
 * @typedef {import('./external-source-spec.mjs').ExternalRecord} ExternalRecord
 * @typedef {import('./unit-graph.mjs').PluginPlace} PluginPlace
 * @typedef {import('./external-source-prep.mjs').PrepState} PrepState
 */

// The lenses whose classes turn on another system's behaviour: lifecycle, compatibility and races.
export const EXTERNAL_LENSES = ['reconciler', 'compat', 'concurrency', 'failure-windows']
// adversarial-review's equivalents: races (concurrency) and what a failed call leaves behind (errors: rollback and
// cleanup on the error path, its failure windows); it has no lifecycle or compatibility lens of its own.
export const ADVERSARIAL_EXTERNAL_LENSES = ['concurrency', 'errors']

/**
 * The run's external sources: the records (recalled, or forwarded by a launching audit), the one prep agent
 * (at most once a run, only for a plan with one of `lenses`, EXTERNAL_LENSES unless the engine names its own,
 * dispatched under the engine's `prepPhase`), and the blocks and section it feeds. A launcher takes a nested run's
 * prep (`outcome`, then `adopt`) in place of its own when that prep answered for every record it holds.
 * @param {{ ragent: (prompt: string, opts: object) => Promise<unknown>, plugin: PluginPlace, logLine: (m: string) => void, lenses?: string[], prepPhase?: string }} io
 */
export function makeExternalSources({ ragent, plugin, logLine, lenses: reading = EXTERNAL_LENSES, prepPhase = 'Scout' }) {
  /** @type {ExternalRecord[]} */
  let records = []
  /** @type {PrepState} */
  let state = { ran: false, prepared: [], failed: [], unreachable: '' }
  /** @type {Promise<void> | null} */
  let pending = null
  async function run() {
    try {
      state = readPrep(await ragent(sourcePrepPrompt(records, plugin), { label: 'external-sources', phase: prepPhase, schema: SOURCE_PREP_SCHEMA, model: 'haiku', effort: 'low' }), records)
    } catch (e) {
      state = { ran: true, prepared: [], failed: [], unreachable: `the source agent did not run: ${str(e instanceof Error ? e.message : String(e))}` }
    }
    logLine(`External sources: ${state.prepared.length} prepared${state.failed.length || state.unreachable ? `, ${state.unreachable ? records.length : state.failed.length} without context` : ''}`)
  }
  /** Whether a prep is due: a record, and a lens of `lenses` that reads external sources. @param {string[]} lenses */
  const due = lenses => records.length > 0 && lenses.some(l => reading.includes(l))
  return {
    /** @param {unknown} list the recalled `external` records */
    setRecords(list) {
      const read = externalRecords(list)
      records = read.records
      for (const x of read.refused) logLine(`⚠️ ${x}`)
    },
    /** Runs the prep once, when there is a record and `lenses` hold one that reads external sources. @param {string[]} lenses */
    async prepare(lenses) {
      if (!due(lenses)) return
      if (!pending) pending = run()
      await pending
    },
    /** Names a prep that was due and is not run (`why`, e.g. the budget floor): the section warns of it. @param {string[]} lenses @param {string} why */
    skip(lenses, why) {
      if (due(lenses) && !pending) state = { ...state, skipped: why }
    },
    /** @param {string} lens */
    lensBlock: lens => (reading.includes(lens) ? lensSourcesBlock(state.prepared) : ''),
    verifyBlock: () => verifySourcesBlock(state.prepared),
    /** @param {Array<Record<string, unknown>>} findings */
    section: findings => externalSourcesSection(state, records, findings),
    /** The prep's answer per system with the record it answered, as a launcher adopts it; null when no prep ran or the cache was unreachable. */
    outcome: () => (state.ran && !state.unreachable ? [...state.prepared, ...state.failed].map(e => ({ ...e, ...specOf(records.find(r => r.system === e.system)) })) : null),
    /**
     * A nested run's `outcome` taken as this run's prep, so no second agent prepares the same systems: only before
     * a prep of its own, and only when it answers every record for the same system, repo, versionFrom and
     * versionMatch; each directory is checked again (trustedDir). Whether it was taken.
     * @param {unknown} systems @returns {boolean}
     */
    adopt(systems) {
      if (pending || !records.length || !Array.isArray(systems)) return false
      /** @param {ExternalRecord} r */
      const answer = r => systems.find(x => sameSpec(x, r))
      if (!records.every(answer)) return false
      state = readPrep({ systems: records.map(answer) }, records)
      pending = Promise.resolve()
      logLine(`External sources: ${state.prepared.length} prepared by the nested run, taken without a prep of this run's own`)
      return true
    },
  }
}
