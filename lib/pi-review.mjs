// The craft review in pi (realm @nick/craft, nodes #453, #465): the craft-review skill of craft's pi package
// (integrations/pi/skills) has the pi session run this one command and relay what it prints. It is the shared
// process-per-task driver (lib/task-process-entry.mjs) with pi as its host: the review's own arguments, plus two of
// its own: `concurrency=<n>` (task processes at once, default 4; env CRAFT_PI_CONCURRENCY) and `piModels=<model>` or
// `<tier>=<model>,…` (the pi model for the binary's Claude tiers, default pi's own configured model; env
// CRAFT_PI_MODELS). Each task is its own `pi -p` (lib/pi-review-task.mjs), `pi` the one on PATH unless CRAFT_PI_BIN
// names one. Progress goes to stderr, the answer — the `## Verdict` block — to stdout.
//
// Run: node <package root>/lib/pi-review.mjs [key=value ...]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { concurrencyOf, runDriver } from './task-process-entry.mjs'
import { modelTable } from './task-process-agents.mjs'
import { runTask } from './pi-review-task.mjs'
import { runIfMain } from './script-main.mjs'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// A pi model as `--model` takes it: a pattern or an ID, `provider/id`, an optional `:<thinking>`.
const PI_MODEL = /^[\w.:/@*-]{1,120}$/

/**
 * The driver's own arguments, taken out of `a`, with the environment's defaults; or why one cannot be used.
 * @param {Record<string, unknown>} a @param {NodeJS.ProcessEnv} env
 * @returns {{ concurrency: number, models: Map<string, string> } | { refused: string }}
 */
export function piOptions(a, env) {
  const lanes = concurrencyOf(a, env, 'CRAFT_PI_CONCURRENCY')
  const spec = a['piModels'] ?? env['CRAFT_PI_MODELS'] ?? ''
  delete a['piModels']
  if ('refused' in lanes) return lanes
  const read = modelTable(String(spec), 'piModels', PI_MODEL)
  return 'refused' in read ? read : { concurrency: lanes.concurrency, models: read.table }
}

/** @type {import('./task-process-entry.mjs').Host} */
const PI = {
  name: 'pi',
  script: 'pi-review.mjs',
  // This package's version: the release the checkout carries (release-please's manifest).
  version: () => String(JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.release-please-manifest.json'), 'utf8'))['.']),
  own: piOptions,
  runTask: (own, at) => t => runTask(t, { ...at, models: own.models, pi: at.env['CRAFT_PI_BIN'] || 'pi' }),
}

/** @param {string[]} argv @param {NodeJS.ProcessEnv} env @param {import('./task-process-entry.mjs').Deps} [deps] */
export const run = (argv, env = process.env, deps = {}) => runDriver(PI, argv, env, deps)

await runIfMain(import.meta.url, run)
