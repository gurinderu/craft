// The craft review in Codex (realm @nick/craft, node #491, on the route #454 chose): the craft:codex-review skill
// has the Codex session run this one command and relay what it prints. It is the shared process-per-task driver
// (lib/task-process-entry.mjs) with Codex as its host: the review's own arguments, plus two of its own:
// `concurrency=<n>` (task processes at once, default 4; env CRAFT_CODEX_CONCURRENCY) and `codexModels=<model>` or
// `<tier>=<model>,…` (the Codex model for the binary's Claude tiers, default the session's own; env
// CRAFT_CODEX_MODELS). Each task is its own `codex exec` (lib/codex-review-task.mjs), `codex` the one on PATH unless
// CRAFT_CODEX_BIN names one. Progress goes to stderr, the answer — the `## Verdict` block — to stdout.
//
// Run: node <plugin root>/lib/codex-review.mjs [key=value ...]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { concurrencyOf, runDriver } from './task-process-entry.mjs'
import { modelTable } from './codex-review-agents.mjs'
import { runTask } from './codex-review-task.mjs'
import { runIfMain } from './script-main.mjs'

/** @typedef {import('./task-process-entry.mjs').Deps} Deps */

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The driver's own arguments, taken out of `a`, with the environment's defaults; or why one cannot be used.
 * @param {Record<string, unknown>} a @param {NodeJS.ProcessEnv} env
 * @returns {{ concurrency: number, models: Map<string, string> } | { refused: string }}
 */
export function driverOptions(a, env) {
  const lanes = concurrencyOf(a, env, 'CRAFT_CODEX_CONCURRENCY')
  const spec = a['codexModels'] ?? env['CRAFT_CODEX_MODELS'] ?? ''
  delete a['codexModels']
  if ('refused' in lanes) return lanes
  const read = modelTable(String(spec))
  return 'refused' in read ? read : { concurrency: lanes.concurrency, models: read.table }
}

/** @type {import('./task-process-entry.mjs').Host} */
const CODEX = {
  name: 'Codex',
  script: 'codex-review.mjs',
  // This plugin's version, from the Codex manifest.
  version: () => String(JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.codex-plugin', 'plugin.json'), 'utf8')).version),
  own: driverOptions,
  runTask: (own, at) => t => runTask(t, { ...at, models: own.models, codex: at.env['CRAFT_CODEX_BIN'] || 'codex' }),
}

/** @param {string[]} argv @param {NodeJS.ProcessEnv} env @param {Deps} [deps] */
export const run = (argv, env = process.env, deps = {}) => runDriver(CODEX, argv, env, deps)

await runIfMain(import.meta.url, run)
