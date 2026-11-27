// The review's tasks as the plugin runs them on both lines: the binary hands each back (`--delegate`, realm @nick/craft,
// nodes #496, #626, #627, #720) and the plugin runs it as a child session of the calling session,
// on the agent and model the binary names. The binary bounds each by its kind's deadline and says a task
// no longer awaited, which aborts that child.
//   • The agents the runtime lists go to the binary (`--agents`), which places each task on the agent it names when it is listed —
//     on 1.x subagents are not listed, so their tasks run on `review-task` (host-v1-read.ts) —
//     a task whose own agent is missing runs on `review-task`, said degraded. The listing fails closed: no list, an
//     error, or no `review-task` runs nothing, since a child named an agent the runtime lacks may run on its writable
//     default.
//   • A child is made where its parent is (opencode-v2.d.ts; on 1.x, realm @nick/craft, node #719), so the repository the
//     task reviews — craft's worktree of a PR, say — is named at the head of its prompt.
//   • At most the cap of children run at once (`--concurrency`, else `CRAFT_OPENCODE_CONCURRENCY`, else 4), and a child
//     that gave nothing back, or broke before its loop ended, is tried once more alone — no other child of this review
//     running beside it: the plugin's own fan-out's mitigation of opencode's concurrent-child bugs (child-run.ts).
import type { DelegatedTask } from '../../shared/craft-review-run.mjs'
import { runChildSession } from './child-run.ts'
import { ChildSessionFailed, type Host, type ModelRef } from './host.ts'

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

/** A cap from 1 to 16, or undefined. */
const capOf = (text: string | undefined) => {
  const n = Number(text)
  return text !== undefined && Number.isInteger(n) && n >= 1 && n <= 16 ? n : undefined
}

/**
 * The children run at once, as the binary takes its own: the review's `--concurrency`, else `CRAFT_OPENCODE_CONCURRENCY`
 * (1 to 16), else 4.
 */
export function childCap(words: readonly string[] = [], env: NodeJS.ProcessEnv = process.env): number {
  const at = words.indexOf('--concurrency')
  const flag = at >= 0 ? words[at + 1] : words.find(w => w.startsWith('--concurrency='))?.slice('--concurrency='.length)
  return capOf(flag) ?? capOf(env['CRAFT_OPENCODE_CONCURRENCY']) ?? 4
}

/** Why a task's child never started: it was given up — cancelled, past its deadline, or its run gone — while it waited. */
export const GIVEN_UP = 'the task was given up before its child session started'

/** How a review's children take their turns: `shared` up to the cap at once, `alone` with no other running. */
export interface Turns {
  shared<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T>
  alone<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T>
}

/**
 * The turns of one review's children: at most `cap` shared works at once, and an `alone` work only once none runs, none
 * starting beside it; each in the order it asked. A wait ends when its signal aborts, so a task's turn is bounded by
 * its deadline.
 */
export function turns(cap: number): Turns {
  let active = 0
  let exclusive = false
  const queue: { alone: boolean; go: () => void }[] = []
  const pump = () => {
    for (let head = queue[0]; head && !exclusive && (head.alone ? active === 0 : active < cap); head = queue[0]) {
      queue.shift()
      active++
      exclusive = head.alone
      head.go()
    }
  }
  const enter = (alone: boolean, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error(GIVEN_UP))
        return
      }
      const onAbort = () => {
        queue.splice(queue.indexOf(entry), 1)
        reject(new Error(GIVEN_UP))
        pump()
      }
      const entry = {
        alone,
        go: () => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        },
      }
      signal.addEventListener('abort', onAbort, { once: true })
      queue.push(entry)
      pump()
    })
  const within =
    (alone: boolean) =>
    async <T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> => {
      await enter(alone, signal)
      try {
        return await work()
      } finally {
        active--
        if (alone) exclusive = false
        pump()
      }
    }
  return { shared: within(false), alone: within(true) }
}

/**
 * The task's prompt headed by the repository it reviews, by its absolute path quoted as a JSON string: a child session
 * starts where its parent is (opencode-v2.d.ts), and is asked to use absolute paths under it rather than to `cd`.
 */
export const inRepository = (cwd: string, prompt: string) =>
  `WORKING DIRECTORY: this task reviews the repository at the absolute path ${JSON.stringify(cwd)}, not the directory this session starts in. Read every file and run every command by absolute paths under it (for git, \`git -C\` with that path).\n\n${prompt}`

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * `run` in a shared turn, and once more alone — no other child of this review running — when it gave nothing back or
 * broke before its loop ended (the plugin's own fan-out's mitigation of opencode's concurrent-child bugs, child-run.ts).
 * Never once the task is given up, nor after a loop that failed: that error is the answer. Before a broken or abandoned
 * first attempt throws or returns, its session is asked to stop and the stop awaited for a bounded time (host-v2.ts); a
 * stop OpenCode fails or does not confirm in that time is logged, and that child may then run beside the retry. When the
 * retry fails too, the first error is kept, the retry's beside it.
 */
async function retriedAlone(run: () => Promise<string>, turn: Turns, signal: AbortSignal): Promise<string> {
  let first: unknown
  try {
    const text = await turn.shared(run, signal)
    if (text || signal.aborted) return text
  } catch (e) {
    if (signal.aborted || e instanceof ChildSessionFailed) throw e
    first = e
  }
  try {
    return await turn.alone(run, signal)
  } catch (e) {
    if (first === undefined) throw e
    throw new Error(`${messageOf(first)} (tried once more alone: ${messageOf(e)})`, { cause: first })
  }
}

/**
 * The runner of the binary's delegated tasks: each one child session under `parent`, on the task's model or, when it
 * names none, `fallback` — the calling session's own, its variant kept.
 */
export function childTasks(host: Host, parent: string | undefined, fallback?: ModelRef, cap = childCap()) {
  const turn = turns(cap)
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
    return retriedAlone(run, turn, signal)
  }
}
