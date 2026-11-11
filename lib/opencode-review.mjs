// The craft review in OpenCode (realm @nick/craft, nodes #453, #465): the OpenCode plugin's `review` tool calls this
// with the tool's argument text and the host's child-session call (integrations/opencode/plugin/host.ts, runChild),
// on either OpenCode runtime. It holds no review logic: the arguments are read and refused by the Codex driver's rules
// (lib/codex-review.mjs, readArgs) under OpenCode's own names — `concurrency=<n>` (child sessions at once, default 4;
// env CRAFT_OPENCODE_CONCURRENCY) and `opencodeModels=<provider/model>` or `<tier>=<provider/model>,…` (the model for
// the binary's tiers, default the session's own; env CRAFT_OPENCODE_MODELS) — and the step loop is the shared one
// (lib/codex-review-run.mjs), its rounds child sessions (lib/opencode-review-round.mjs). The `craft` binary is this
// version's released one (lib/craft-bin.mjs) unless craftBin= names one.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { VALUE_REFUSED_CLASS } from './cli-review-keys.mjs'
import { stoppedAnswer } from './cli-review-verdict.mjs'
import { codexRecorder } from './codex-review-record.mjs'
import { binaryOf, readArgs, refuse } from './codex-review.mjs'
import { driveReview } from './codex-review-run.mjs'
import { openCodeRounds } from './opencode-review-round.mjs'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const KEYS = { concurrency: 'concurrency', concurrencyEnv: 'CRAFT_OPENCODE_CONCURRENCY', models: 'opencodeModels', modelsEnv: 'CRAFT_OPENCODE_MODELS' }

/** @typedef {import('./opencode-review-task.mjs').ChildRequest} ChildRequest */
/**
 * @typedef {{ runChild: (req: ChildRequest) => Promise<string>, directory: string, env?: NodeJS.ProcessEnv, log?: (line: string) => void,
 *   store?: string, ensureBin?: typeof import('./craft-bin.mjs').ensure, deadlineMs?: (kind: string | undefined) => number }} Deps
 *   directory: the session's checkout, the repository when repo= names none; store: the run store
 */

/** This plugin's version, from the Claude Code manifest release-please moves with every release. @returns {string} */
const pluginVersion = () => String(JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'integrations', 'claude-code', '.claude-plugin', 'plugin.json'), 'utf8')).version)

/** How to run this driver again on a run. @param {string} run */
const driverHint = run => `the \`review\` tool again with \`run=${run}\``

/** A model in the table OpenCode cannot name: each must be `provider/model`. @param {Map<string, string>} models */
const unnamedModel = models => [...models.values()].find(m => !/^[^/\s]+\/\S+$/.test(m))

/** The review's options and the driver's own, or why they are refused. @param {string} text @param {NodeJS.ProcessEnv} env @param {(line: string) => void} log */
function readAll(text, env, log) {
  const args = readArgs(text, env, log, KEYS)
  if ('refused' in args) return args
  const bad = unnamedModel(args.driver.models)
  return bad === undefined ? args : { refused: `review: opencodeModels names "${bad}", which is not <provider>/<model>. Nothing ran.`, cls: VALUE_REFUSED_CLASS, a: { repo: args.o.repo } }
}

/**
 * Run one review and return its answer: the `## Verdict` block of a finished run, or what stopped it.
 * @param {string} text the tool's argument text: `key=value` words or one JSON object @param {Deps} deps
 * @returns {Promise<string>}
 */
export async function reviewInOpenCode(text, deps) {
  const env = deps.env ?? process.env
  const log = deps.log ?? (() => {})
  const version = pluginVersion()
  const store = deps.store ?? ''
  const args = readAll(text, env, log)
  if ('refused' in args) return refuse(args, { version, cwd: deps.directory, store, log, driver: driverHint })
  const { o, driver } = args
  const repo = o.repo || deps.directory
  const recorder = codexRecorder({ craftVersion: version, repo: o.repo, depth: o.depth || 'full', strict: o.strict, via: o.via, store, cwd: deps.directory, log, driver: driverHint })
  const got = await binaryOf(o.craftBin, version, env, deps)
  if ('error' in got) {
    const unfiled = await recorder.unfinished(!!o.run, { verdict: 'INCOMPLETE', notRun: ['the craft binary did not finish the run'] })
    return [stoppedAnswer(got.error), unfiled, recorder.notes()].filter(Boolean).join('\n\n')
  }
  log(`review ${version} in OpenCode: ${got.bin} over ${repo}, up to ${driver.concurrency} child session(s) at once`)
  const rounds = openCodeRounds({ runChild: deps.runChild, pluginRoot: PLUGIN_ROOT, repo, models: driver.models, concurrency: driver.concurrency, log, ...(deps.deadlineMs ? { deadlineMs: deps.deadlineMs } : {}) })
  // The binary's prompts name review rules under CLAUDE_PLUGIN_ROOT; the checkout the plugin is linked from holds them.
  const ctx = { bin: got.bin, version, pluginRoot: PLUGIN_ROOT, driver: driverHint, log, recorder, repo, env: { ...env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT }, runRound: rounds }
  return (await driveReview(o, ctx)).answer
}
