// The review's external sources (realm @nick/craft, node #430, the records of node #431): when memory holds an
// `external` record for the diff's paths and the run has a lens that judges another system's behaviour, ONE
// cheap agent prepares their source (lib/external-source-prep.mjs), and the directories it prepared reach those
// lenses and every verifier as an EXTERNAL SOURCES block; the report says what was and was not
// (lib/external-source-text.mjs). When the diff touched a deployment manifest, the same agent runs the discovery
// CLI over those files (node #435), and the section prints each candidate no record covers, ready for the human to
// confirm with craft:memory (node #436: the engine itself never writes memory, #206). This module is the run's kit.
import { externalRecords } from './external-source-spec.mjs'
import { SOURCE_PREP_SCHEMA, readDiscovery, readPrep, sameSpec, sourcePrepPrompt, specOf, str } from './external-source-prep.mjs'
import { touchedManifests } from './manifest-paths.mjs'
import { externalSourcesSection, lensSourcesBlock, verifySourcesBlock } from './external-source-text.mjs'

/**
 * @typedef {import('./external-source-spec.mjs').ExternalRecord} ExternalRecord
 * @typedef {import('./unit-graph.mjs').PluginPlace} PluginPlace
 * @typedef {import('./external-source-prep.mjs').PrepState} PrepState
 * @typedef {import('./external-source-prep.mjs').DiscoveryState} DiscoveryState
 * @typedef {import('./external-candidate.mjs').RecordLike} RecordLike
 */

// The lenses whose classes turn on another system's behaviour: lifecycle, compatibility and races.
export const EXTERNAL_LENSES = ['reconciler', 'compat', 'concurrency', 'failure-windows']
// adversarial-review's equivalents: races (concurrency) and what a failed call leaves behind (errors: rollback and
// cleanup on the error path, its failure windows); it has no lifecycle or compatibility lens of its own.
export const ADVERSARIAL_EXTERNAL_LENSES = ['concurrency', 'errors']

/**
 * The objects of `list`, each read field by field as text (coveredBy), so a malformed one covers nothing.
 * @param {unknown} list @returns {RecordLike[]}
 */
const asRecords = list => /** @type {RecordLike[]} */ ((Array.isArray(list) ? list : []).filter(x => x && typeof x === 'object' && !Array.isArray(x)))

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
  // Every active external record whatever its scope, as the discovery's filter of what is already recorded.
  /** @type {RecordLike[]} */
  let known = []
  /** @type {PrepState} */
  let state = { ran: false, prepared: [], failed: [], unreachable: '' }
  /** @type {DiscoveryState} */
  let found = { ran: false, candidates: [], error: '' }
  // The touched manifests the discovery reads, and how many past its bound it does not.
  let manifests = /** @type {string[]} */ ([])
  let dropped = 0
  /** @type {Promise<void> | null} */
  let pending = null
  /** @type {Promise<void> | null} */
  let discovering = null
  /** The one agent for what is due: its answer, or why it did not run. @param {boolean} prep @param {string[]} over @returns {Promise<{ raw: unknown } | { why: string }>} */
  async function ask(prep, over) {
    try {
      return { raw: await ragent(sourcePrepPrompt(prep ? records : [], plugin, over), { label: 'external-sources', phase: prepPhase, schema: SOURCE_PREP_SCHEMA, model: 'haiku', effort: 'low' }) }
    } catch (e) {
      return { why: `the source agent did not run: ${str(e instanceof Error ? e.message : String(e))}` }
    }
  }
  /** @param {{ raw: unknown } | { why: string }} got */
  function settlePrep(got) {
    state = 'why' in got ? { ran: true, prepared: [], failed: [], unreachable: got.why } : readPrep(got.raw, records)
    const without = state.unreachable ? records.length : state.failed.length
    logLine(`External sources: ${state.prepared.length} prepared${without ? `, ${without} without context` : ''}`)
  }
  /** @param {{ raw: unknown } | { why: string }} got @param {string[]} over */
  function settleDiscovery(got, over) {
    found = 'why' in got ? { ran: true, candidates: [], error: got.why } : readDiscovery(got.raw, over, [...records, ...known])
    logLine(`External candidates: ${found.candidates.length} from ${over.length} touched manifest(s)${found.error ? ` — ${found.error}` : ''}`)
  }
  /** One agent for what is due: the prep (`prep`), the discovery over `over` (when not empty). @param {boolean} prep @param {string[]} over */
  async function run(prep, over) {
    const got = await ask(prep, over)
    if (prep) settlePrep(got)
    if (over.length) settleDiscovery(got, over)
  }
  /** Whether a prep is due: a record, and a lens of `lenses` that reads external sources. @param {string[]} lenses */
  const due = lenses => records.length > 0 && lenses.some(l => reading.includes(l))
  /**
   * Runs, once each and in one agent when both are due, the prep (a record and a lens of `lenses` that reads
   * external sources) and the discovery (a touched manifest). @param {string[]} lenses
   */
  async function prepare(lenses) {
    const [prep, disc] = [!pending && due(lenses), !discovering && manifests.length > 0]
    if (prep || disc) {
      const p = run(prep, disc ? manifests : [])
      if (prep) pending = p
      if (disc) discovering = p
    }
    await Promise.all([pending, discovering])
  }
  return {
    /** @param {unknown} list the recalled `external` records */
    setRecords(list) {
      const read = externalRecords(list)
      records = read.records
      for (const x of read.refused) logLine(`⚠️ ${x}`)
    },
    /**
     * Every active `external` record the store holds, whatever its scope (the recall's `knownExternals`): a
     * discovered candidate one of them covers is not printed. Only the discovery reads them; the prep stays with
     * the scope-matched records. @param {unknown} list
     */
    setKnown(list) {
      known = asRecords(list)
    },
    /** The run's changed files: the deployment manifests among them are what the discovery reads. @param {string[]} files */
    touch(files) {
      ({ manifests, dropped } = touchedManifests(files))
    },
    /**
     * Another run (the nested review) discovered over `covered` — its scout lists every changed path, whatever files
     * it was confined to — so this run discovers in none of them: each manifest is read once a run tree. A manifest
     * the other run did not account for (its scout died, it ended before its discovery) stays this run's.
     * @param {unknown} covered  the other run's `externalManifests`
     */
    untouch(covered) {
      const theirs = Array.isArray(covered) ? covered.filter(x => typeof x === 'string') : []
      manifests = manifests.filter(m => !theirs.includes(m))
      if (!manifests.length) dropped = 0
    },
    /** The touched manifests whose fate the section reports — the discovery ran or said why not — as a launcher reads them. */
    discovered: () => (found.ran || found.skipped ? [...manifests] : []),
    /**
     * The discovery alone, for a run that reviews nothing (an inert diff, a `nix flake update`; realm @nick/craft,
     * node #435): no prep, no lens. `recall`, when given, brings the store's `external` records the discovery leaves
     * out — a run whose launcher recalled holds them already. Returns the section, '' when no manifest was touched.
     * @param {string[]} files @param {(() => Promise<{ externals: unknown, knownExternals: unknown }>) | null} recall
     * @param {string} [skipWhy]  why the discovery may not run (e.g. the budget floor), '' when it may
     */
    async inert(files, recall, skipWhy = '') {
      ({ manifests, dropped } = touchedManifests(files))
      if (!manifests.length) return ''
      if (skipWhy) found = { ...found, skipped: skipWhy }
      else {
        const r = recall ? await recall() : null
        if (r) known = [...known, ...asRecords(r.externals), ...asRecords(r.knownExternals)]
        await prepare([])
      }
      return externalSourcesSection(state, records, [], { ...found, manifests, dropped })
    },
    prepare,
    /** Names a prep or a discovery that was due and is not run (`why`, e.g. the budget floor): the section warns of it. @param {string[]} lenses @param {string} why */
    skip(lenses, why) {
      if (due(lenses) && !pending) state = { ...state, skipped: why }
      if (manifests.length && !discovering) found = { ...found, skipped: why }
    },
    /** @param {string} lens */
    lensBlock: lens => (reading.includes(lens) ? lensSourcesBlock(state.prepared) : ''),
    verifyBlock: () => verifySourcesBlock(state.prepared),
    /** @param {Array<Record<string, unknown>>} findings */
    section: findings => externalSourcesSection(state, records, findings, { ...found, manifests, dropped }),
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
