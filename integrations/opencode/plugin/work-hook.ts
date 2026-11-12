// craft's hook at the moment of work, the OpenCode side (realm @nick/craft, node #288): the decision is
// lib/work-hook-opencode.mjs, this file is the runtime-free core between it and the two hosts. host-v1.ts
// feeds it from `chat.message` and `event`, host-v2.ts from the session `prompt` hook and `ctx.event`; each
// says how the lines reach the message (`deliver`). The lib modules load lazily and any failure is silence:
// the hook must never cost the plugin its tools (realm @nick/craft, #276).
import { homedir } from 'node:os'
import type { WorkHook } from './host.ts'

type Modules = [typeof import('../../../lib/work-hook-opencode.mjs'), typeof import('../../../lib/hook-log.mjs')]
let modules: Promise<Modules | null> | undefined
const load = (): Promise<Modules | null> =>
  (modules ??= Promise.all([import('../../../lib/work-hook-opencode.mjs'), import('../../../lib/hook-log.mjs')]).catch(() => null))

type Where = { directory: string; home: string; env: Record<string, string | undefined> }
type Subagent = { parent: string; agent: string }

// One message the hook answers: decide, log, and hand the lines to `deliver` when there are any.
async function respond(where: Where, session: string, prompt: string, subagent: Subagent | null, deliver: (text: string) => boolean): Promise<void> {
  const m = await load()
  if (!m) return
  const file = m[1].hookLogPath(where.home)
  const message = { prompt, session, cwd: where.directory, ...subagent }
  const { text, entry } = m[0].opencodeMessage(message, where.env, new Date(), () => m[1].readHookLog(file) ?? [])
  const placed = text ? deliver(text) : false
  // Nothing to build the lines on: the log says so rather than claiming they were said.
  if (text && !placed && entry) Object.assign(entry, { spoke: false, silent: 'no-part' })
  if (entry) m[1].appendHookLog(entry, file)
}

async function compacted(where: Where, session: string): Promise<void> {
  const m = await load()
  if (!m) return
  const file = m[1].hookLogPath(where.home)
  const entry = m[0].opencodeCompacted(session, where.directory, new Date(), () => m[1].readHookLog(file) ?? [])
  if (entry) m[1].appendHookLog(entry, file)
}

/**
 * The hook's core. `engineSessions` are the sessions the plugin's own workflows opened (orchestrator.ts): their
 * agents are the loop and hear nothing, as the Workflow tool's do in Claude Code.
 */
export function workHook(
  directory: string,
  engineSessions: ReadonlySet<string>,
  home: string = homedir(),
  env: Record<string, string | undefined> = process.env,
): WorkHook {
  const where = { directory, home, env }
  // A subagent's session → its parent (and agent, when the runtime names it at creation) until its first
  // message, then null: later messages stay silent.
  const children = new Map<string, Subagent | null>()
  return {
    childCreated(id, parent, agent) {
      children.set(id, { parent, agent: agent ?? '' })
    },
    async compacted(session) {
      try {
        await compacted(where, session)
      } catch {
        /* silence */
      }
    },
    async message(session, prompt, agent, deliver) {
      try {
        const child = children.get(session)
        if (engineSessions.has(session) || child === null) return
        if (child !== undefined) children.set(session, null)
        const subagent = child === undefined ? null : { parent: child.parent, agent: agent ?? child.agent }
        await respond(where, session, prompt, subagent, deliver)
      } catch {
        /* silence */
      }
    },
  }
}
