// The external sources' prep (realm @nick/craft, node #430, the records of node #431): the one cheap agent's prompt,
// which carries the command this module builds for lib/craft-source.mjs (the sandbox cannot spawn a process, #134),
// and its answer read against the records asked for — a directory trusted only where the engine computes it.
import { pluginScriptPrelude, shq } from './run-logging.mjs'
import { cacheSegments, encodeSpec, refFault, repoUrlParts } from './external-source-spec.mjs'
import { flattenField } from './prompt-fields.mjs'

/**
 * @typedef {import('./external-source-spec.mjs').ExternalRecord} ExternalRecord
 * @typedef {import('./unit-graph.mjs').PluginPlace} PluginPlace
 * @typedef {{ system: string, ref: string, dir: string }} Prepared
 * @typedef {{ ran: boolean, prepared: Prepared[], failed: { system: string, error: string }[], unreachable: string, skipped?: string }} PrepState  `skipped` why a prep that was due did not run
 */

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
export const str = v => (typeof v === 'string' ? flattenField(v) : '')

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

/** The fields that identify what a record asks to prepare. @param {ExternalRecord | undefined} r */
export const specOf = r => (r ? { repo: r.repo, versionFrom: r.versionFrom, versionMatch: r.versionMatch } : {})
/** Whether an adopted entry answers this record: the same system, repo, versionFrom and versionMatch. @param {unknown} x @param {ExternalRecord} r */
export function sameSpec(x, r) {
  const e = /** @type {Record<string, unknown>} */ (x && typeof x === 'object' ? x : {})
  return e['system'] === r.system && e['repo'] === r.repo && e['versionFrom'] === r.versionFrom && e['versionMatch'] === r.versionMatch
}
