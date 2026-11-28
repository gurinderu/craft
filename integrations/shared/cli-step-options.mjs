// The arguments every kind's driver of the CLI's step protocol takes (integrations/shared/cli-step-driver.mjs; realm
// @nick/craft, nodes #411, #616): the repository, the binary to run (craftBin), the plugin root (craftRoot) and a run to
// resume (run) — and the refusals every kind makes before anything runs: an argument the engine does not take, a start
// option beside run=, a repo= or a path no agent can quote. The kind reads its own start options beside them.
import { UNKNOWN_OPTION_CLASS, unknownOptionsRefusal } from './workflow-args.mjs'
import { REPO_REFUSED_CLASS, readRepoArg } from './repo-arg.mjs'
import { absolutePath } from './cli-review-step.mjs'
import { shellWord } from './plugin-script.mjs'

/** @typedef {import('./cli-step-read.mjs').KindOptions} KindOptions */

/** The arguments every kind takes beside its own. */
export const COMMON_KEYS = Object.freeze(['craftRoot', 'craftBin', 'repo', 'run'])

/** Why a path argument cannot be quoted to an agent. */
const PATH_REFUSED_CLASS = 'a path argument refused — not an absolute path an agent can quote, nothing ran'

/**
 * Start-only arguments cannot change the saved run (realm @nick/craft, node #616).
 * @param {Record<string, unknown>} a @param {readonly string[]} startOnly @param {string} engine
 */
function startOnlyBesideRun(a, startOnly, engine) {
  if (!a['run']) return ''
  const given = startOnly.filter(k => a[k] !== undefined)
  return given.length
    ? `${engine} cannot honour ${given.map(k => `\`${k}\``).join(', ')} beside run=: a resumed run keeps its start options. Drop them to resume it, or start a new run to change them. Nothing ran.`
    : ''
}

/**
 * A path argument as given: '' when absent, the path when absolute, else its refusal.
 * @param {Record<string, unknown>} a @param {string} key @returns {{ path: string } | { refused: string }}
 */
function pathArg(a, key) {
  if (!a[key]) return { path: '' }
  const path = absolutePath(a[key])
  return path === null ? { refused: `${key}=${JSON.stringify(a[key])} refused: not an absolute path. Nothing ran.` } : { path }
}

/**
 * The arguments every kind takes, and every refusal of them with its class — the kind's own `extra` among them, after
 * the unknown and start-only ones — so a caller fixing one does not meet the next on the re-launch.
 * @param {Record<string, unknown>} a  normalizeArgs' result
 * @param {{ engine: string, keys: readonly string[], startOnly: readonly string[], extra?: Array<[string, string]> }} kind
 *   the Workflow's name, every argument it takes, those a resume refuses, and its own refusals ('' for none)
 * @returns {{ common: KindOptions, refused: Array<[string, string]> }}
 */
export function readCommonOptions(a, { engine, keys, startOnly, extra = [] }) {
  const repo = readRepoArg(a['repo'])
  const paths = Object.fromEntries(['craftBin', 'craftRoot', 'run'].map(k => [k, pathArg(a, k)]))
  /** @type {Array<[string, string]>} */
  const all = [
    [unknownOptionsRefusal(a, keys, engine), UNKNOWN_OPTION_CLASS],
    [startOnlyBesideRun(a, startOnly, engine), 'start options beside run= were refused, nothing ran'],
    ...extra,
    [repo.refused, REPO_REFUSED_CLASS],
    ...Object.values(paths).map(p => /** @type {[string, string]} */ (['refused' in p ? p.refused : '', PATH_REFUSED_CLASS])),
  ]
  /** @param {string} k */
  const path = k => {
    const p = paths[k]
    return p && 'path' in p ? p.path : ''
  }
  return {
    refused: all.filter(([why]) => why),
    common: { repo: repo.repo, craftBin: path('craftBin') ? shellWord(path('craftBin')) : null, craftRoot: path('craftRoot'), run: path('run') },
  }
}
