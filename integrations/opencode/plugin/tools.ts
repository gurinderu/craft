// The tools craft registers in OpenCode, once for both runtimes: host-v1.ts turns each into a `tool()`,
// host-v2.ts into a `ctx.tool` definition with a JSON Schema input.
import type { Host, ModelRef, ToolAnswer, ToolCall, ToolSpec } from './host.ts'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { runChildSession } from './child-run.ts'
import { runRustAudit } from './rust-audit.ts'
import { runTriageFindings } from './triage-findings.ts'

// The host as a workflow sees it from inside one tool call: every child session it opens nests under the calling
// session (OpenCode's parentID, observed on 1.19.5 and 2.2.7); a call with no session leaves them top-level.
export function nestedUnder(host: Host, parent: string | undefined): Host {
  if (!parent) return host
  return { ...host, runChild: req => host.runChild({ ...req, parentID: parent }) }
}

// The review is the craft binary's own driver with its opencode backend, run through the plugin's bin/craft
// (integrations/shared/craft-review-run.mjs; realm @nick/craft, nodes #499, #503): each task an `opencode run` on craft's read-only
// agents, every tier on the calling session's model unless the flags name `--models` or the environment
// `CRAFT_OPENCODE_MODELS`, which the binary reads itself. integrations/shared/ is loaded from the
// checkout the plugin is linked from when the tool runs, as the work hook loads its modules: a plugin copy without
// integrations/shared/ keeps its other tools.
// On 2.x the binary delegates each task (`--delegate`, realm @nick/craft, nodes #496, #626) and the plugin runs it as a
// child session of the calling session, on the agent and model the binary names, so the tasks show as its subagents;
// the binary bounds each by its kind's deadline and says a task no longer awaited, which aborts that child.
type DelegatedTask = { label: string; agent: string | null; model: string | null; prompt: string }

/** A model as the binary names it — `provider/model`, a `#variant` allowed — or undefined for the session's own. */
export function modelRef(name: string | null): ModelRef | undefined {
  const at = name?.indexOf('/') ?? -1
  if (!name || at <= 0) return undefined
  const [modelID = '', variant] = name.slice(at + 1).split('#')
  return { providerID: name.slice(0, at), modelID, ...(variant ? { variant } : {}) }
}

/** The runner of the binary's delegated tasks: each one child session under `parent`. */
export const childTasks =
  (host: Host, parent: string | undefined) =>
  (task: DelegatedTask, signal: AbortSignal): Promise<string> => {
    const model = modelRef(task.model)
    return runChildSession(host, {
      title: `craft review: ${task.label}`,
      agent: task.agent ?? '',
      prompt: task.prompt,
      signal,
      ...(model ? { model } : {}),
      ...(parent ? { parentID: parent } : {}),
    })
  }

const hasModels = (words: string[]) => words.some(w => w === '--models' || w.startsWith('--models='))

function stopPreflight(pid: number | undefined) {
  if (!pid || process.platform === 'win32') return
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    // The process may already have exited.
  }
}

async function profilePreflight(wrapper: string, cwd: string, signal?: AbortSignal): Promise<string | undefined> {
  const child = spawn('sh', [wrapper, 'init', '--propose', '--cwd', cwd], { cwd, detached: process.platform !== 'win32', ...(signal ? { signal } : {}) })
  const stop = () => {
    stopPreflight(child.pid)
    child.kill()
  }
  signal?.addEventListener('abort', stop, { once: true })
  const timer = setTimeout(stop, 120_000)
  try {
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
    })
    await new Promise<void>((resolve, reject) => {
      child.on('error', reject)
      child.on('close', code => (code === 0 ? resolve() : reject(new Error(`init exited ${String(code)}: ${stderr}`))))
    })
    const result: unknown = JSON.parse(stdout)
    if (!result || typeof result !== 'object' || !('exists' in result) || typeof result.exists !== 'boolean') {
      return 'The review profile could not be checked: craft init returned an invalid response. Nothing ran.'
    }
    return result.exists
      ? undefined
      : `No review profile exists for ${cwd}. Ask the user whether to set it up with the review-init skill for that repository or continue without it. To continue without setup, call review again with --without-profile. Nothing ran.`
  } catch (error) {
    return `The review profile could not be checked: ${String(error)}. Nothing ran.`
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', stop)
  }
}

function profileOptions(words: string[], directory: string) {
  const skip = words.includes('--without-profile')
  const forwarded = words.filter(w => w !== '--without-profile')
  const resumed = forwarded.some(w => w === '--run' || w.startsWith('--run='))
  const cwdIndex = forwarded.indexOf('--cwd')
  const requestedCwd = cwdIndex >= 0 ? forwarded[cwdIndex + 1] : forwarded.find(w => w.startsWith('--cwd='))?.slice(6)
  return { forwarded, skip, resumed, cwd: path.resolve(directory, requestedCwd ?? '.') }
}

// The read-only agent every delegated task runs on unless the binary names another; a child session named an agent the
// runtime lacks may run on its writable default, so the review refuses first, as the binary's own opencode preflight does.
const TASK_AGENT = 'review-task'

/** Why a 2.x review cannot run its tasks as child sessions, or undefined when it can (or the agents cannot be listed). */
async function missingTaskAgent(host: Host): Promise<string | undefined> {
  const agents = await host.agents?.().catch(() => undefined)
  if (!agents || agents.includes(TASK_AGENT)) return undefined
  return `⚠️ INCOMPLETE — the craft OpenCode agents are not installed or are out of date: this OpenCode has no \`${TASK_AGENT}\` agent, which every review task runs on read-only. Add the craft package of this release (\`opencode plugin add\`), or rerun integrations/opencode/install.sh. Nothing ran.`
}

/** The flags with the calling session's model added, unless they or the environment name the models. */
async function withCallerModel(host: Host, forwarded: string[], sessionID: string | undefined): Promise<string[]> {
  const mapped = hasModels(forwarded) || Boolean(process.env['CRAFT_OPENCODE_MODELS'])
  const model = mapped || !sessionID ? undefined : await host.callerModel(sessionID).catch(() => undefined)
  return model ? [...forwarded, '--models', `${model.providerID}/${model.modelID}`] : forwarded
}

async function runReview(host: Host, args: string, call: ToolCall, children = false): Promise<ToolAnswer> {
  const missing = children ? await missingTaskAgent(host) : undefined
  if (missing) return { title: 'craft review: INCOMPLETE', output: missing }
  const review = await import('../../shared/craft-review-run.mjs')
  const { forwarded, skip, resumed, cwd } = profileOptions(review.flagWords(args), host.directory)
  if (!skip && !resumed) {
    const why = await profilePreflight(review.WRAPPER, cwd, call.signal)
    if (why) return { title: 'craft review: profile', output: why }
  }
  const outcome = await review.runReview({
    backend: 'opencode',
    args: await withCallerModel(host, forwarded, call.sessionID),
    cwd: host.directory,
    ...(call.signal ? { signal: call.signal } : {}),
    onProgress: p => call.progress?.(review.progressLine(p)),
    ...(children ? { onTask: childTasks(host, call.sessionID) } : {}),
  })
  return { title: `craft review: ${review.summaryOf(outcome).verdict}`, output: review.answerText(outcome) }
}

// What the audit and the triage answer on OpenCode 2.x, before any child session: no 2.x child session was seen
// answering in their runs. Built here, without integrations/shared/, so a plugin copy without it still answers. The
// review is not refused: its tasks run as child sessions too, read by the reply reader fixed for #626 (host-v2.ts); the
// audit's and the triage's runs on that reader are not yet observed, so they stay refused.
export function refusalOnV2(name: string): string {
  return `⚠️ INCOMPLETE — craft's \`${name}\` does not yet work in OpenCode 2.x: its child sessions never answered in testing (craft 0.50.0, OpenCode 2.2.7). A route through \`opencode run\` is in progress; until it ships, use OpenCode 1.x, Claude Code, Codex or pi. Nothing ran.`
}

/**
 * The tools as the 2.x entry (`setup`) registers them: the review runs each task as a child session of the caller
 * (childTasks); the audit and the triage refuse up front and say so in their description; all stay registered, to
 * answer a call with why.
 */
export const onV2 = (tools: readonly ToolSpec[]): ToolSpec[] =>
  tools.map(spec =>
    spec.name === 'review'
      ? {
          ...spec,
          description: spec.description.replace(ONE_RUN_EACH, 'each task runs as a child session of this session'),
          run: (host, args, call) => runReview(host, args['args'] ?? '', call, true),
        }
      : {
          ...spec,
          description: `Not available on OpenCode 2.x yet: craft's \`${spec.name}\` answers INCOMPLETE and runs nothing (use OpenCode 1.x, Claude Code, Codex or pi).`,
          run: () => Promise.resolve(refusalOnV2(spec.name)),
        },
  )

/** What the review answers when craft's agents, commands and skills could not be registered (plugin-content.ts). */
export function unregisteredAnswer(reason: string): string {
  return `⚠️ INCOMPLETE — craft could not register its agents, commands and skills on this OpenCode: ${reason}. The review runs every task on craft's \`review-task\` agent, which is not there. Nothing ran.`
}

/**
 * The tools when the registration failed: the review says why in its description and answer instead of running into
 * the binary's "not installed" refusal, which would send the user to reinstall a package that is installed.
 */
export const withoutContent = (tools: readonly ToolSpec[], reason: string): ToolSpec[] =>
  tools.map(spec =>
    spec.name === 'review'
      ? {
          ...spec,
          description: `Not available here: craft could not register its agents, commands and skills on this OpenCode (${reason}); a call answers INCOMPLETE and runs nothing.`,
          run: () => Promise.resolve(unregisteredAnswer(reason)),
        }
      : spec,
  )

// How the 1.x review's description says its tasks run; 2.x says child sessions in its place.
const ONE_RUN_EACH = 'each task runs as its own `opencode run`'

export const TOOLS: readonly ToolSpec[] = [
  {
    name: 'rust-audit',
    description:
      'Full Rust crate audit: fan out the craft review agents (reviewer, architecture, security, and Miri if unsafe is present) and synthesize one severity-ranked report. Optional arg `base` fixes the diff base ref.',
    args: { base: { optional: true } },
    run: (host, args, call) => runRustAudit(nestedUnder(host, call.sessionID), args['base'] === undefined ? {} : { base: args['base'] }),
  },
  {
    name: 'triage-findings',
    description:
      'Validate review findings against the code and render one ordered fix plan + triage ledger (no edits). Arg `locator` points at the findings source (a report path, PR ref, or pasted findings).',
    args: { locator: { optional: false } },
    run: (host, args, call) => runTriageFindings(nestedUnder(host, call.sessionID), { locator: args['locator'] ?? '' }),
  },
  {
    name: 'review',
    description:
      "craft's review of the current change by the `craft` binary (`craft review run --backend opencode`): the mechanical gate, review lenses per language profile, verification, one report and the `## Verdict` block; each task runs as its own `opencode run` on craft's read-only agents, on this session's model. It runs long. When the profile is missing, ask the user to set it up with review-init or continue without it; pass --without-profile only on their choice. Arg `args` takes the review's flags as one string (for example `--base main`, `--depth light`, `--pr 123 --comment`, `--run <dir>` to resume, `--models <provider/model>`), or none.",
    args: { args: { optional: true } },
    run: (host, args, call) => runReview(host, args['args'] ?? '', call),
  },
]
