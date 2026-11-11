// The 2.x side of the host (host.ts), on the surface opencode-v2.d.ts pins: `ctx.session` runs child sessions,
// `ctx.tool` registers the tools with a JSON Schema input (no Effect, no zod: 2.2.7 accepts plain JSON Schema),
// and the session `prompt` hook plus `ctx.event` feed the work hook.
import { stringArgs, type Host, type ToolSpec, type WorkHook } from "./host.ts"
import type { V2Context, V2Event, V2ToolDefinition } from "./opencode-v2.js"
import { replyDeadlineMs, replyOf } from "./host-v2-reply.ts"
import { shellIn } from "./shell.mjs"

// How long to wait between reads of a child session that is not yet done.
const POLL_MS = 500

// `replyMs`: each child session's own idle deadline (host-v2-reply.ts), clamped to the caller's `deadlineMs`.
export function v2Host(ctx: V2Context, pollMs = POLL_MS, replyMs = replyDeadlineMs(process.env)): Host {
  const directory = ctx.location.directory
  return {
    directory,
    worktree: ctx.location.project?.directory ?? directory,
    sh: shellIn(directory),
    async runChild(req) {
      const session = await ctx.session.create({
        title: req.title,
        ...(req.agent ? { agent: req.agent } : {}),
        ...(req.model ? { model: { providerID: req.model.providerID, id: req.model.modelID } } : {}),
        ...(req.parentID ? { parentID: req.parentID } : {}),
      })
      req.onSession?.(session.id)
      const ms = Math.min(replyMs, req.deadlineMs ?? Infinity)
      const send = () => ctx.session.prompt({ sessionID: session.id, text: req.prompt })
      return replyOf(ctx, session.id, send, { ms, pollMs, ...(req.signal ? { signal: req.signal } : {}) })
    },
    // The session's own model, set at creation or by a switch (observed on opencode 2.2.7); none when it has none.
    async callerModel(sessionID) {
      const model = (await ctx.session.get({ sessionID })).model
      return model ? { providerID: model.providerID, modelID: model.id } : undefined
    },
    // The agents' ids `agent.list` answers (observed on opencode 2.2.7: `{ location, data: [{ id, … }] }`).
    async agents() {
      const res = await ctx.agent.list()
      return new Set(res.data.map((a) => a.id))
    },
  }
}

export function v2Tool(host: Host, spec: ToolSpec): V2ToolDefinition {
  const properties = Object.fromEntries(Object.keys(spec.args).map((k) => [k, { type: "string" }]))
  const required = Object.entries(spec.args).filter(([, a]) => !a.optional).map(([k]) => k)
  return {
    name: spec.name,
    description: spec.description,
    input: { type: "object", properties, required, additionalProperties: false },
    execute: async (input, call) => ({ content: [{ type: "text", text: await spec.run(host, stringArgs(spec, input), { sessionID: call.sessionID }) }] }),
  }
}

async function pump(events: AsyncIterator<V2Event>, work: WorkHook): Promise<void> {
  for (let next = await events.next(); !next.done; next = await events.next()) {
    const { type, data } = next.value
    if (type === "session.created" && data.parentID) work.childCreated(data.sessionID, data.parentID, data.agent)
    else if (type === "session.compaction.ended") await work.compacted(data.sessionID)
  }
}

// The work hook on 2.x. There is no `chat.message`: the closest mechanism is the session `prompt` hook, which
// sees the prompt's text before it is admitted and may rewrite it, so the lines are appended to the prompt
// itself (they become part of the user's message, not a separate synthetic part).
async function hookWork(ctx: V2Context, work: WorkHook): Promise<() => Promise<void>> {
  const reg = await ctx.session.hook("prompt", (input) =>
    work.message(input.sessionID, input.prompt.text, undefined, (text) => {
      input.prompt.text = `${input.prompt.text}\n\n${text}`
      return true
    }),
  )
  const events = ctx.event.subscribe({ types: ["session.created", "session.compaction.ended"] })[Symbol.asyncIterator]()
  pump(events, work).catch(() => { /* silence: the hook never costs the tools (realm @nick/craft, #276) */ })
  return async () => {
    await reg.dispose()
    await events.return?.()
  }
}

/** Everything the 2.x runtime gets from `setup()`: the tools and the work hook; resolves to their disposer. */
export async function v2Setup(ctx: V2Context, tools: readonly ToolSpec[], work: WorkHook): Promise<() => Promise<void>> {
  const host = v2Host(ctx)
  const toolReg = await ctx.tool.transform((editor) => {
    for (const spec of tools) editor.add(v2Tool(host, spec))
  })
  const unhook = await hookWork(ctx, work).catch(() => async () => {})
  return async () => {
    await toolReg.dispose()
    await unhook()
  }
}
