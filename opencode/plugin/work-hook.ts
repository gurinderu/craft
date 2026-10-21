// craft's hook at the moment of work, the OpenCode side (realm @nick/craft, node #288): the decision is
// lib/work-hook-opencode.mjs, this file only reads OpenCode's hooks and writes back. A user message arrives as
// `chat.message`, whose output parts the hook may extend; a subagent's session is known by `session.created` with a
// parentID; a compaction by `session.compacted`. The lib modules load lazily and any failure is silence: the hook
// must never cost the plugin its tools (realm @nick/craft, #276).
import { homedir } from "node:os"
import type { Hooks } from "@opencode-ai/plugin"
import type { Part, TextPart } from "@opencode-ai/sdk"

type Modules = [typeof import("../../lib/work-hook-opencode.mjs"), typeof import("../../lib/hook-log.mjs")]
let modules: Promise<Modules | null> | undefined
const load = (): Promise<Modules | null> =>
  (modules ??= Promise.all([import("../../lib/work-hook-opencode.mjs"), import("../../lib/hook-log.mjs")]).catch(() => null))

// The words the human (or the parent agent) wrote: the message's own text parts.
function promptOf(parts: Part[]): string {
  return parts.filter((p): p is TextPart => p.type === "text" && !p.synthetic && !p.ignored).map(p => p.text).join("\n")
}

// The added part sorts after the message's last one: an id built on that part's own.
function syntheticPart(parts: Part[], text: string): TextPart | null {
  const last = parts.at(-1)
  if (!last || typeof last.id !== "string") return null
  return { id: `${last.id}-craft`, sessionID: last.sessionID, messageID: last.messageID, type: "text", text, synthetic: true }
}

type Where = { directory: string, home: string, env: Record<string, string | undefined> }

// One message the hook answers: decide, log, and append the lines when there are any.
async function respond(where: Where, session: string, parts: Part[], subagent: { parent: string, agent: string } | null): Promise<void> {
  const m = await load()
  if (!m) return
  const file = m[1].hookLogPath(where.home)
  const message = { prompt: promptOf(parts), session, cwd: where.directory, ...subagent }
  const { text, entry } = m[0].opencodeMessage(message, where.env, new Date(), () => m[1].readHookLog(file) ?? [])
  const part = text ? syntheticPart(parts, text) : null
  // Nothing to build the part on: the log says so rather than claiming the lines were said.
  if (text && !part && entry) Object.assign(entry, { spoke: false, silent: "no-part" })
  if (entry) m[1].appendHookLog(entry, file)
  if (part) parts.push(part)
}

async function compacted(where: Where, session: string): Promise<void> {
  const m = await load()
  if (!m) return
  const file = m[1].hookLogPath(where.home)
  const entry = m[0].opencodeCompacted(session, where.directory, new Date(), () => m[1].readHookLog(file) ?? [])
  if (entry) m[1].appendHookLog(entry, file)
}

/**
 * The plugin's `event` and `chat.message` hooks. `engineSessions` are the sessions the plugin's own workflows
 * opened (orchestrator.ts): their agents are the loop and hear nothing, as the Workflow tool's do in Claude Code.
 */
export function workHooks(
  directory: string,
  engineSessions: ReadonlySet<string>,
  home: string = homedir(),
  env: Record<string, string | undefined> = process.env,
): Required<Pick<Hooks, "event" | "chat.message">> {
  const where = { directory, home, env }
  // A subagent's session → its parent session until its first message, then null: later messages stay silent.
  const children = new Map<string, string | null>()
  return {
    async event({ event }) {
      try {
        if (event.type === "session.created" && event.properties.info.parentID) {
          children.set(event.properties.info.id, event.properties.info.parentID)
        } else if (event.type === "session.compacted") {
          await compacted(where, event.properties.sessionID)
        }
      } catch { /* silence */ }
    },
    async "chat.message"(input, output) {
      try {
        const session = input.sessionID
        const parent = children.get(session)
        if (engineSessions.has(session) || parent === null) return
        if (parent !== undefined) children.set(session, null)
        await respond(where, session, output.parts, parent === undefined ? null : { parent, agent: input.agent ?? "" })
      } catch { /* silence */ }
    },
  }
}
