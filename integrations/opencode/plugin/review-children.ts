// The 2.x review's tasks as the plugin runs them: the binary hands each back (`--delegate`, realm @nick/craft, nodes
// #496, #626, #627) and the plugin runs it as a child session of the calling session, so the tasks show as its
// subagents, on the agent and model the binary names. The binary bounds each by its kind's deadline and says a task no
// longer awaited, which aborts that child.
//   • The agents the runtime lists go to the binary (`--agents`), which places each task as it does for `opencode run`:
//     a task whose own agent is missing runs on `review-task`, said degraded. The listing fails closed: no list, an
//     error, or no `review-task` runs nothing, since a child named an agent the runtime lacks may run on its writable
//     default.
//   • A child is made where its parent is (opencode-v2.d.ts), so the repository the task reviews — craft's worktree of a
//     PR, say — is named at the head of its prompt.
//   • At most `childCap()` children run at once, and a child that gave nothing back, or broke before its loop ended, is
//     tried once more alone (child-run.ts, `solo`): the plugin's own fan-out's mitigation of opencode's concurrent-child
//     bugs.
import type { DelegatedTask } from '../../shared/craft-review-run.mjs'
import { runChildSession, solo } from './child-run.ts'
import type { Host, ModelRef } from './host.ts'
import { ChildSessionFailed } from './host-v2.ts'

/** The read-only agent every review task runs on unless the binary names another. */
export const TASK_AGENT = 'review-task'

/** A model as the binary names it — `provider/model`, a `#variant` allowed — or undefined when it names none. */
export function modelRef(name: string | null): ModelRef | undefined {
  const at = name?.indexOf('/') ?? -1
  if (!name || at <= 0) return undefined
  const [modelID = '', variant] = name.slice(at + 1).split('#')
  return modelID ? { providerID: name.slice(0, at), modelID, ...(variant ? { variant } : {}) } : undefined
}

const incomplete = (why: string) => `⚠️ INCOMPLETE — ${why}. Nothing ran.`

/** The agents this runtime lists, for the binary's `--agents`; or why the review cannot run on them. */
export async function taskAgents(host: Host): Promise<{ agents: string[] } | { refused: string }> {
  if (!host.agents)
    return { refused: incomplete("craft cannot list this OpenCode's agents, so it cannot check that every review task runs on a read-only agent") }
  let agents: string[]
  try {
    agents = await host.agents()
  } catch (e) {
    return {
      refused: incomplete(
        `craft could not list this OpenCode's agents (${e instanceof Error ? e.message : String(e)}), so it cannot check that every review task runs on a read-only agent`,
      ),
    }
  }
  if (agents.includes(TASK_AGENT)) return { agents }
  return {
    refused: incomplete(
      `the craft OpenCode agents are not installed or are out of date: this OpenCode has no \`${TASK_AGENT}\` agent, which every review task runs on read-only. Add the craft package of this release (\`opencode plugin add\`), or rerun integrations/opencode/install.sh`,
    ),
  }
}

/** The children run at once: `CRAFT_OPENCODE_CONCURRENCY` (1 to 16), as the binary reads it, else 4. */
export function childCap(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env['CRAFT_OPENCODE_CONCURRENCY'])
  return Number.isInteger(n) && n >= 1 && n <= 16 ? n : 4
}

/** At most `n` works at once, the rest waiting in turn. */
export function slots(n: number): <T>(work: () => Promise<T>) => Promise<T> {
  let free = n
  const waiting: (() => void)[] = []
  return async work => {
    if (free > 0) free--
    else await new Promise<void>(resolve => waiting.push(resolve))
    try {
      return await work()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else free++
    }
  }
}

/** The task's prompt headed by the repository it reviews: a child session starts where its parent is. */
export const inRepository = (cwd: string, prompt: string) =>
  `WORKING DIRECTORY: this task reviews the repository at ${cwd} — run every command there (\`cd ${cwd}\` first) and read every path relative to it, not the directory this session starts in.\n\n${prompt}`

/** `run`, and once more alone when it gave nothing back or broke before its loop ended; never once given up. */
async function retriedAlone(run: () => Promise<string>, signal: AbortSignal): Promise<string> {
  try {
    const text = await run()
    if (text || signal.aborted) return text
  } catch (e) {
    if (signal.aborted || e instanceof ChildSessionFailed) throw e
  }
  return solo(run)
}

/**
 * The runner of the binary's delegated tasks: each one child session under `parent`, on the task's model or, when it
 * names none, `fallback` — the calling session's own, its variant kept.
 */
export function childTasks(host: Host, parent: string | undefined, fallback?: ModelRef, cap = childCap()) {
  const slot = slots(cap)
  return (task: DelegatedTask, signal: AbortSignal): Promise<string> => {
    const model = modelRef(task.model) ?? fallback
    const run = () =>
      runChildSession(host, {
        title: `craft review: ${task.label}`,
        agent: task.agent || TASK_AGENT,
        prompt: inRepository(task.cwd, task.prompt),
        signal,
        ...(model ? { model } : {}),
        ...(parent ? { parentID: parent } : {}),
      })
    return retriedAlone(() => slot(run), signal)
  }
}
