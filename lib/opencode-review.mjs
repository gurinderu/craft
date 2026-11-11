// The craft review in OpenCode (realm @nick/craft, nodes #453, #465): the OpenCode plugin's `review` tool calls this
// with the tool's argument text and the host's child-session call (integrations/opencode/plugin/host.ts, runChild),
// on either OpenCode runtime. It is the shared driver (lib/task-process-entry.mjs) with OpenCode as its host: the
// review's own arguments plus two of its own — `concurrency=<n>` (child sessions at once, default 4; env
// CRAFT_OPENCODE_CONCURRENCY) and `opencodeModels=<provider/model>` or `<tier>=<provider/model>,…` (the model for the
// binary's tiers, default the calling session's; env CRAFT_OPENCODE_MODELS) — each task one child session
// (lib/opencode-review-task.mjs). It holds no review logic. Progress goes to `log`, the answer is returned.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { concurrencyOf, runDriver } from './task-process-entry.mjs'
import { modelTable } from './task-process-agents.mjs'
import { runTask } from './opencode-review-task.mjs'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// An OpenCode model as both runtimes take it: `provider/model`, the model part free to carry its own slashes.
const OPENCODE_MODEL = /^[\w.@-]{1,60}\/[\w.:/@-]{1,120}$/

/** @typedef {import('./opencode-review-task.mjs').ChildRequest} ChildRequest */
/**
 * @typedef {{ runChild: (req: ChildRequest) => Promise<string>, directory: string, env?: NodeJS.ProcessEnv, log?: (line: string) => void } & Omit<import('./task-process-entry.mjs').Deps, 'cwd'>} Deps
 *   directory: the session's checkout, the repository when repo= names none
 */

/**
 * The driver's own arguments, taken out of `a`, with the environment's defaults; or why one cannot be used.
 * @param {Record<string, unknown>} a @param {NodeJS.ProcessEnv} env
 * @returns {{ concurrency: number, models: Map<string, string> } | { refused: string }}
 */
export function openCodeOptions(a, env) {
  const lanes = concurrencyOf(a, env, 'CRAFT_OPENCODE_CONCURRENCY')
  const spec = a['opencodeModels'] ?? env['CRAFT_OPENCODE_MODELS'] ?? ''
  delete a['opencodeModels']
  if ('refused' in lanes) return lanes
  const read = modelTable(String(spec), 'opencodeModels', OPENCODE_MODEL)
  return 'refused' in read ? read : { concurrency: lanes.concurrency, models: read.table }
}

/**
 * OpenCode as the shared driver's host, its tasks through `runChild`.
 * @param {(req: ChildRequest) => Promise<string>} runChild @returns {import('./task-process-entry.mjs').Host}
 */
const openCode = runChild => ({
  name: 'OpenCode',
  script: 'opencode-review.mjs',
  // This plugin's version: the release the checkout carries (release-please's manifest).
  version: () => String(JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.release-please-manifest.json'), 'utf8'))['.']),
  own: openCodeOptions,
  runTask: (own, at) => t => runTask(t, { ...at, models: own.models, runChild }),
  again: run => `the \`review\` tool again with \`run=${run}\``,
})

/** The tool's argument text as the driver's words: one JSON object as it is, else split at whitespace. @param {string} text */
const argvOf = text => {
  const trimmed = text.trim()
  if (!trimmed) return []
  return trimmed.startsWith('{') ? [trimmed] : trimmed.split(/\s+/)
}

/**
 * Run one review and return its answer: the `## Verdict` block of a finished run, or what stopped it.
 * @param {string} text the tool's argument text: `key=value` words or one JSON object @param {Deps} deps
 * @returns {Promise<string>}
 */
export async function reviewInOpenCode(text, deps) {
  const { runChild, directory, env = process.env, log = () => {}, ...rest } = deps
  const result = await runDriver(openCode(runChild), argvOf(text), env, { ...rest, cwd: directory })
  for (const line of result.stderr) log(line)
  return result.stdout.join('\n')
}
