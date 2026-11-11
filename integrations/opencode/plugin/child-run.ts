// One child session, as every workflow of this plugin runs it: the audit's and the triage's fan-out (orchestrator.ts)
// and the review's tasks (tools.ts → lib/opencode-review-task.mjs). Two shared pieces:
//   • `runChildSession` marks the child as the engine's while it runs — craft's hook at the moment of work stays silent
//     there (work-hook.ts) — and unmarks it when it ends;
//   • `solo` is the one queue retries go through: opencode's child-session execution bugs (anomalyco/opencode #8528,
//     sst/opencode #6573) leave a child created but never run, and the mitigation is to try again ALONE. The fan-out
//     retries its failed jobs one at a time through it; a review task whose child said nothing is tried once more
//     through it (`retryingEmpty`), its first attempt keeping the review runner's own concurrency.
import type { ChildRequest, Host } from "./host.ts"

// The sessions this plugin's workflows are running now: craft's hook at the moment of work stays silent there.
export const ENGINE_SESSIONS = new Set<string>()

/** Run one child session to its end, marked as the engine's while it runs. */
export async function runChildSession(host: Host, req: ChildRequest): Promise<string> {
  let id: string | undefined
  try {
    return await host.runChild({
      ...req,
      onSession: (session) => {
        id = session
        ENGINE_SESSIONS.add(session)
        req.onSession?.(session)
      },
    })
  } finally {
    if (id !== undefined) ENGINE_SESSIONS.delete(id)
  }
}

let soloTail: Promise<unknown> = Promise.resolve()

/** `work` once every earlier solo work has settled: at most one runs at a time, across all workflows. */
export function solo<T>(work: () => Promise<T>): Promise<T> {
  const run = soloTail.then(work, work)
  soloTail = run.catch(() => undefined)
  return run
}

/**
 * The review's child run: one attempt, and when it said nothing (the #8528/#6573 shape), one more attempt alone. A
 * request already aborted (its deadline passed while it waited) does not start again.
 */
export async function retryingEmpty(host: Host, req: ChildRequest): Promise<string> {
  const text = await runChildSession(host, req)
  if (text.trim() || req.signal?.aborted) return text
  return solo(() => (req.signal?.aborted ? Promise.resolve("") : runChildSession(host, req)))
}
