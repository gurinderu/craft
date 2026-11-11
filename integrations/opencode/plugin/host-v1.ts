// The 1.x side of the host (host.ts): the plugin input's SDK `client` runs child sessions, `tool()` registers
// the tools, and `event` / `chat.message` feed the work hook. The client calls are held to a narrow local
// shape rather than the SDK's generated types: the shapes below are the ones the plugin has always sent
// (opencode 1.x SDK docs), and the response is read defensively across the shapes a session may return.
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import type { Part, TextPart } from "@opencode-ai/sdk"
import { stringArgs, type Host, type ModelRef, type ToolSpec, type WorkHook } from "./host.ts"
import { shellIn } from "./shell.mjs"

type TextIn = { type: "text"; text: string }
export interface V1Client {
  session: {
    create(req: { body: { title: string; parentID?: string } }): Promise<unknown>
    messages(req: { path: { id: string } }): Promise<unknown>
    prompt(req: {
      path: { id: unknown }
      body: { agent: string; parts: TextIn[]; model?: { providerID: string; modelID: string } }
    }): Promise<unknown>
  }
}

const field = (v: unknown, k: string): unknown => (typeof v === "object" && v !== null ? (v as Record<string, unknown>)[k] : undefined)

// The parts of a message, wherever the response shape keeps them.
function partsOf(root: unknown): unknown[] {
  const found = [field(root, "parts"), field(field(root, "data"), "parts"), field(field(root, "message"), "parts")].find(Array.isArray)
  return found ?? []
}

export function extractText(res: unknown): string {
  // Normalize a streaming/array response to its last message before reading parts, so an array
  // shape isn't mistaken for "no output" (which would mis-mark a successful job NOT RUN).
  const root: unknown = Array.isArray(res) ? res[res.length - 1] : res
  const text = partsOf(root)
    .filter((p) => field(p, "type") === "text" && typeof field(p, "text") === "string")
    .map((p) => String(field(p, "text")))
    .join("\n")
    .trim()
  const top = field(root, "text")
  return text || (typeof top === "string" ? top.trim() : "")
}

export function v1Host(input: { client: V1Client; directory: string; worktree: string }): Host {
  const { client, directory, worktree } = input
  return {
    directory,
    worktree,
    sh: shellIn(directory),
    async runChild(req) {
      const session = await client.session.create({ body: { title: req.title, ...(req.parentID ? { parentID: req.parentID } : {}) } })
      const id = field(session, "id") ?? field(field(session, "data"), "id")
      if (typeof id === "string") req.onSession?.(id)
      const model = req.model && { providerID: req.model.providerID, modelID: req.model.modelID }
      const res = await client.session.prompt({
        path: { id },
        body: { agent: req.agent, parts: [{ type: "text", text: req.prompt }], ...(model ? { model } : {}) },
      })
      return extractText(res)
    },
    async callerModel(sessionID) {
      return lastModel(await client.session.messages({ path: { id: sessionID } }))
    },
  }
}

// The model a session's newest message names (observed on opencode 1.19.5): a user message's `model`, an assistant
// message's `providerID`/`modelID`.
export function lastModel(res: unknown): ModelRef | undefined {
  const list = field(res, "data") ?? res
  const infos = Array.isArray(list) ? list.map((m) => field(m, "info")) : []
  for (const info of infos.reverse()) {
    const own = field(info, "model")
    const providerID = field(own, "providerID") ?? field(info, "providerID")
    const modelID = field(own, "modelID") ?? field(info, "modelID")
    if (typeof providerID === "string" && typeof modelID === "string") return { providerID, modelID }
  }
  return undefined
}

function v1Tool(host: Host, spec: ToolSpec) {
  const args = Object.fromEntries(
    Object.entries(spec.args).map(([k, a]) => [k, a.optional ? tool.schema.string().optional() : tool.schema.string()]),
  )
  return tool({ description: spec.description, args, execute: (raw, context) => spec.run(host, stringArgs(spec, raw), { sessionID: context.sessionID }) })
}

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

/** The work hook on 1.x: `event` names subagent sessions and compactions, `chat.message` gains a synthetic part. */
export function v1WorkHooks(work: WorkHook): Required<Pick<Hooks, "event" | "chat.message">> {
  return {
    async event({ event }) {
      try {
        if (event.type === "session.created" && event.properties.info.parentID) {
          work.childCreated(event.properties.info.id, event.properties.info.parentID)
        } else if (event.type === "session.compacted") {
          await work.compacted(event.properties.sessionID)
        }
      } catch { /* silence */ }
    },
    async "chat.message"(input, output) {
      try {
        const parts = output.parts
        await work.message(input.sessionID, promptOf(parts), input.agent, (text) => {
          const part = syntheticPart(parts, text)
          if (part) parts.push(part)
          return part !== null
        })
      } catch { /* silence */ }
    },
  }
}

/** Everything the 1.x runtime gets from `server()`: the tools and the work hook. */
export function v1Hooks(input: Pick<PluginInput, "directory" | "worktree"> & { client: unknown }, tools: readonly ToolSpec[], work: WorkHook): Hooks {
  const host = v1Host({ client: input.client as V1Client, directory: input.directory, worktree: input.worktree })
  return { ...v1WorkHooks(work), tool: Object.fromEntries(tools.map((t) => [t.name, v1Tool(host, t)])) }
}
