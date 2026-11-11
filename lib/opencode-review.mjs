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
import { TASK_AGENT, runTask } from './opencode-review-task.mjs'
import { stoppedAnswer } from './cli-review-verdict.mjs'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// An OpenCode model as both runtimes take it: `provider/model`, the model part free to carry its own slashes.
const OPENCODE_MODEL = /^[\w.@-]{1,60}\/[\w.:/@-]{1,120}$/

/** @typedef {import('./opencode-review-task.mjs').ChildRequest} ChildRequest */
/**
 * @typedef {{ runChild: (req: ChildRequest) => Promise<string>, directory: string, agents?: Set<string> | null, readAgents?: () => Promise<Set<string> | null>, agentWaitMs?: number, env?: NodeJS.ProcessEnv, log?: (line: string) => void } & Omit<import('./task-process-entry.mjs').Deps, 'cwd'>} Deps
 *   directory: the session's checkout, the repository when repo= names none; agents: the runtime's agents, null when
 *   unknown; readAgents: reads them again, while a list lacks review-task; agentWaitMs: the pause before each re-read
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
 * @param {(req: ChildRequest) => Promise<string>} runChild @param {Set<string> | null} agents @returns {import('./task-process-entry.mjs').Host}
 */
const openCode = (runChild, agents) => ({
  name: 'OpenCode',
  script: 'opencode-review.mjs',
  // This plugin's version: the release the checkout carries (release-please's manifest).
  version: () => String(JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.release-please-manifest.json'), 'utf8'))['.']),
  own: openCodeOptions,
  runTask: (own, at) => t => runTask(t, { ...at, models: own.models, runChild, agents }),
  again: run => `the \`review\` tool again with \`run=${run}\``,
})

/** The tool's argument text as the driver's words: one JSON object as it is, else split at whitespace. @param {string} text */
const argvOf = text => {
  const trimmed = text.trim()
  if (!trimmed) return []
  return trimmed.startsWith('{') ? [trimmed] : trimmed.split(/\s+/)
}

/**
 * Why a review cannot start on these agents: `review-task` is where every task's read-only session runs, so an OpenCode
 * without it — an install from before it, the agents linked file by file — is refused before any session opens. 2.x
 * accepts an unknown agent at creation and would run the task writable on another; 1.x would fail every task opaquely.
 * Nothing falls back to another agent. Both runtimes list hidden agents, which all of craft's are (observed through
 * `opencode serve` with review-task linked: 1.19.5's `GET /agent` and 2.2.7's `GET /api/agent`, the `agent.list` the
 * plugin's ctx calls, each carry it with `hidden: true`). An unknown list (null) is no evidence, nor is an empty one.
 * 2.2.7 over HTTP loads its instance lazily, and its list fills in over successive calls (observed): first no agents
 * at all, then only its built-ins without review-task, then the full list — so a list without review-task is read
 * again (agentsSettled) before it refuses, and an empty one refuses nothing (a runtime always has its own `build`).
 * @param {Set<string> | null} agents @returns {string | null}
 */
function agentsRefusal(agents) {
  if (!agents?.size || agents.has(TASK_AGENT)) return null
  return `the craft OpenCode agents are not installed or are out of date: rerun integrations/opencode/install.sh (this OpenCode has no \`${TASK_AGENT}\` agent, which every review task runs on read-only). Nothing ran.`
}

const AGENT_REREADS = 3
const AGENT_WAIT_MS = 1000

/**
 * The agent list once it has review-task, or after AGENT_REREADS more reads `waitMs` apart: a runtime still loading
 * its instance lists only part of its agents. Without a way to read again, the first list as it is.
 * @param {Set<string> | null} first @param {(() => Promise<Set<string> | null>) | undefined} again @param {number} waitMs
 * @returns {Promise<Set<string> | null>}
 */
async function agentsSettled(first, again, waitMs) {
  let agents = first
  for (let i = 0; again && i < AGENT_REREADS && agentsRefusal(agents); i++) {
    await new Promise(resolve => setTimeout(resolve, waitMs))
    agents = await again()
  }
  return agents
}

/**
 * Run one review and return its answer: the `## Verdict` block of a finished run, or what stopped it.
 * @param {string} text the tool's argument text: `key=value` words or one JSON object @param {Deps} deps
 * @returns {Promise<string>}
 */
export async function reviewInOpenCode(text, deps) {
  const { runChild, directory, readAgents, agentWaitMs = AGENT_WAIT_MS, env = process.env, log = () => {}, ...rest } = deps
  const agents = await agentsSettled(deps.agents ?? null, readAgents, agentWaitMs)
  const missing = agentsRefusal(agents)
  if (missing) return stoppedAnswer(missing)
  const result = await runDriver(openCode(runChild, agents), argvOf(text), env, { ...rest, cwd: directory })
  for (const line of result.stderr) log(line)
  return result.stdout.join('\n')
}
