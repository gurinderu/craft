// The review's external sources (realm @nick/craft, node #430, the records of node #431): when memory holds an
// `external` record for the diff's paths and the run has a lens that judges another system's behaviour, ONE
// cheap agent runs lib/craft-source.mjs with the spec this module builds — the agent only carries the command
// (the sandbox cannot spawn a process, #134) — and the directories it prepared reach those lenses and every
// verifier as an EXTERNAL SOURCES block. The report names what was prepared, what was not, and the systems a
// finding leaned on that memory does not record; the engine itself never writes memory (#206).
import { pluginScriptPrelude, shq } from './run-logging.mjs'
import { cacheSegments, encodeSpec, externalRecords, refFault, repoUrlParts } from './external-source-spec.mjs'
import { flattenField } from './prompt-fields.mjs'

/**
 * @typedef {import('./external-source-spec.mjs').ExternalRecord} ExternalRecord
 * @typedef {import('./unit-graph.mjs').PluginPlace} PluginPlace
 * @typedef {{ system: string, ref: string, dir: string }} Prepared
 * @typedef {{ ran: boolean, prepared: Prepared[], failed: { system: string, error: string }[], unreachable: string }} PrepState
 */

// The lenses whose classes turn on another system's behaviour: lifecycle, compatibility and races.
export const EXTERNAL_LENSES = ['reconciler', 'compat', 'concurrency', 'failure-windows']
// adversarial-review's equivalents: races (concurrency) and what a failed call leaves behind (errors: rollback and
// cleanup on the error path, its failure windows); it has no lifecycle or compatibility lens of its own.
export const ADVERSARIAL_EXTERNAL_LENSES = ['concurrency', 'errors']
const SOURCE_CLI = 'lib/craft-source.mjs'
const SOURCE_MISSING = 'CRAFT_SOURCE: no usable copy'

/** The CLI's answer, as the agent returns it verbatim. */
export const SOURCE_PREP_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    systems: {
      type: 'array', description: 'the CLI\'s systems, verbatim',
      items: { type: 'object', additionalProperties: false, properties: { system: { type: 'string' }, ref: { type: 'string' }, dir: { type: 'string' }, error: { type: 'string' } } },
    },
    error: { type: 'string', description: 'the CLI\'s error verbatim, or what it printed when that was no JSON object' },
  },
}

/**
 * The prep agent's prompt: one command per system, each locating the shipped CLI like the logger and preparing
 * that system alone, so each runs in a Bash call of its own under the tool's longest timeout.
 * @param {ExternalRecord[]} records @param {PluginPlace} plugin
 */
export function sourcePrepPrompt(records, plugin) {
  const locate = pluginScriptPrelude(plugin.craftRoot, plugin.version, plugin.repo, SOURCE_CLI, 'CRAFT_SOURCE')
  /** @param {ExternalRecord} r @param {number} i */
  const command = (r, i) => `${i + 1}. ${r.system}:
\`\`\`sh
${locate}if [ -n "\${CRAFT_SOURCE:-}" ]; then cd ${shq(plugin.repo || '.')} && node "$CRAFT_SOURCE" prepare --repo-root "$(git rev-parse --show-toplevel)" --spec ${encodeSpec([r])}; else printf '%s\\n' "${SOURCE_MISSING} — \${CRAFT_SOURCE_WHY}"; fi
\`\`\``
  return `Fetch the source of the external systems this review reads. Change nothing in the repository and write nothing yourself.
Run each command below ONCE, exactly as written, each in a Bash call of its own with the Bash tool's timeout set to 600000 (a first clone can take minutes):
${records.map(command).join('\n')}
Each prints a JSON object. Your answer is {"systems": [...]}: for a command that printed {"systems": [...]}, its entries unchanged — nothing added, nothing reshaped; for a command that printed anything else (an {"error"}, other text, nothing), the entry {"system": "<the name before that command>", "error": "<what it printed, at most 300 characters>"}. Never clone, fetch or download anything yourself.`
}

/** @param {unknown} v */
const str = v => (typeof v === 'string' ? flattenField(v) : '')

/**
 * The agent's answer read against the systems asked for: each prepared (an absolute directory and a safe
 * revision), failed with the CLI's reason, or failed for want of an answer; a dead agent or the CLI's own
 * error makes the cache unreachable for all of them.
 * @param {unknown} raw @param {ExternalRecord[]} records @returns {PrepState}
 */
export function readPrep(raw, records) {
  const r = /** @type {Record<string, unknown>} */ (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {})
  const systems = Array.isArray(r['systems']) ? r['systems'] : null
  if (!systems) return { ran: true, prepared: [], failed: [], unreachable: str(r['error']) || 'the source agent returned no answer' }
  /** @type {PrepState} */
  const state = { ran: true, prepared: [], failed: [], unreachable: '' }
  for (const rec of records) {
    const got = systemOutcome(systems, rec)
    if ('dir' in got) state.prepared.push(got)
    else state.failed.push(got)
  }
  return state
}

/**
 * One system's entry in the answer, else why not. A directory is trusted only when it is absolute and ends with
 * the cache path the engine computes itself from the record's repo and the answered revision, as the CLI does
 * (cacheSegments): a model cannot point a lens anywhere else.
 * @param {unknown[]} systems @param {ExternalRecord} rec @returns {Prepared | { system: string, error: string }}
 */
function systemOutcome(systems, { system, repo }) {
  const e = /** @type {Record<string, unknown>} */ (systems.find(x => x && typeof x === 'object' && /** @type {Record<string, unknown>} */ (x)['system'] === system) ?? {})
  const [ref, dir] = [str(e['ref']), str(e['dir'])]
  if (!dir) return { system, error: str(e['error']) || 'no prepared directory in the answer' }
  return trustedDir(repo, ref, dir) ? { system, ref, dir } : { system, error: 'prep answer not trusted' }
}

/** Whether `dir` is absolute, without a `.` or `..` segment, and ends with `/<host>/<path>@<ref>` for this repo and a safe ref. @param {string} repo @param {string} ref @param {string} dir */
export function trustedDir(repo, ref, dir) {
  const parts = repoUrlParts(repo)
  if ('error' in parts || refFault(ref) || !dir.startsWith('/') || dir.split('/').some(s => s === '..' || s === '.')) return false
  return dir.endsWith(`/${cacheSegments(parts, ref).join('/')}`)
}

/** The lenses' block; '' when nothing was prepared. @param {Prepared[]} prepared */
export function lensSourcesBlock(prepared) {
  if (!prepared.length) return ''
  return `EXTERNAL SOURCES (read-only — the source of a system this code relies on, at the version the consumer deploys; read it with your own Read, Grep and Glob tools inside that directory, never modify it):
${prepared.map(p => `- ${p.system} @ ${p.ref}: ${p.dir}`).join('\n')}
A claim about how one of these systems behaves must cite \`<dir>/<path>:<line>\` under its directory above in \`whereChecked\`, and the finding names the system in \`externalSystem\`. For a system not listed here the race catalogue's R20 holds: the claim stands only on that system's source at the deployed version, opened by you, or it is an open question.`
}

/** The verifiers' block; '' when nothing was prepared. @param {Prepared[]} prepared */
export function verifySourcesBlock(prepared) {
  if (!prepared.length) return ''
  return `EXTERNAL SOURCES (read-only, the deployed version of each system): ${prepared.map(p => `${p.system} @ ${p.ref} at ${p.dir}`).join('; ')}. A \`whereChecked\` under one of these directories is that system's own source: open it there to judge the premise.\n`
}

/**
 * The report section: what was prepared, what was not (a warning: reviewed without that context), and the
 * systems findings leaned on that memory has no record of; '' when none of it applies.
 * @param {PrepState} state @param {ExternalRecord[]} records @param {Array<Record<string, unknown>>} findings
 */
export function externalSourcesSection(state, records, findings) {
  const known = new Set(records.map(r => r.system.toLowerCase()))
  const named = [...new Set(findings.map(f => str(f['externalSystem'])).filter(Boolean))]
  const unrecorded = named.filter(s => !known.has(s.toLowerCase()))
  const lines = [
    ...state.prepared.map(p => `- ${p.system} @ ${p.ref}: \`${p.dir}\``),
    ...(state.unreachable ? [`- ⚠️ the source cache was unreachable (${state.unreachable}) — ${records.map(r => r.system).join(', ')} reviewed without external context`] : []),
    ...state.failed.map(f => `- ⚠️ ${f.system}: ${f.error} — reviewed without external context`),
    ...unrecorded.map(s => `- not recorded: ${s} — record it with craft:memory record-external`),
  ]
  return lines.length ? `\n\n## External sources\n${lines.join('\n')}\n` : ''
}

/**
 * The run's external sources: the records (recalled, or forwarded by a launching audit), the one prep agent
 * (at most once a run, only for a plan with one of `lenses`, EXTERNAL_LENSES unless the engine names its own,
 * dispatched under the engine's `prepPhase`), and the blocks and section it feeds.
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
  return {
    /** @param {unknown} list the recalled `external` records */
    setRecords(list) {
      const read = externalRecords(list)
      records = read.records
      for (const x of read.refused) logLine(`⚠️ ${x}`)
    },
    /** Runs the prep once, when there is a record and `lenses` hold one that reads external sources. @param {string[]} lenses */
    async prepare(lenses) {
      if (!records.length || !lenses.some(l => reading.includes(l))) return
      if (!pending) pending = run()
      await pending
    },
    /** @param {string} lens */
    lensBlock: lens => (reading.includes(lens) ? lensSourcesBlock(state.prepared) : ''),
    verifyBlock: () => verifySourcesBlock(state.prepared),
    /** @param {Array<Record<string, unknown>>} findings */
    section: findings => externalSourcesSection(state, records, findings),
  }
}
