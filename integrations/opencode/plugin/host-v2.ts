// The 2.x side of the host (host.ts), on the surface opencode-v2.d.ts pins: `ctx.session` runs child sessions,
// `ctx.tool` registers the tools with a JSON Schema input (no Effect, no zod: 2.2.7 accepts plain JSON Schema),
// and the session `prompt` hook plus `ctx.event` feed the work hook.
import { stringArgs, type Host, type ToolSpec, type WorkHook } from './host.ts'
import type { V2Context, V2Event, V2Message, V2ToolDefinition } from './opencode-v2.js'
import { shellIn } from './shell.mjs'

// How long to wait between reads of a child session that is not yet done, and how many reads before giving
// up. The orchestrator's own deadline (orchestrator.ts) is the real bound; this only keeps the loop from
// outliving it by much.
const POLL_MS = 500
const MAX_POLLS = 3 * 60 * 60 * 2

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

// The text of the session's last message, when it is a finished assistant turn; null while it is not.
export function finishedReply(messages: readonly V2Message[]): string | null {
  const last = messages.at(-1)
  if (!last || last.type !== 'assistant') return null
  if (last.finish === undefined && last.time?.completed === undefined) return null
  return (last.content ?? [])
    .filter(c => c.type === 'text' && typeof c.text === 'string')
    .map(c => c.text)
    .join('\n')
    .trim()
}

const STOPPED = 'the child session was stopped at its deadline'

// `work`, or a rejection as soon as `signal` aborts: a `wait` that never returns does not hold the loop past the abort.
// Its listener goes once the race settles, so the polls do not pile them up on the signal.
function untilAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work
  let onAbort = () => {}
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error(STOPPED))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  return Promise.race([work, aborted]).finally(() => signal.removeEventListener('abort', onAbort))
}

// `wait` may resolve before the admitted prompt's loop has started, so idle is read as "look again", and
// only a finished assistant message is an answer (UNOBSERVED with a real model: opencode-v2.d.ts). An abort (the
// caller's deadline) ends the polling, even mid-`wait`: the session itself is interrupted by `stopOnAbort`.
async function awaitReply(ctx: V2Context, sessionID: string, pollMs: number, signal?: AbortSignal): Promise<string> {
  for (let i = 0; i < MAX_POLLS; i++) {
    if (signal?.aborted) throw new Error(STOPPED)
    await untilAbort(ctx.session.wait({ sessionID }), signal)
    if (signal?.aborted) throw new Error(STOPPED)
    const reply = finishedReply(await ctx.session.context({ sessionID }))
    if (reply !== null) return reply
    await pause(pollMs)
  }
  return ''
}

// On abort, interrupt the session's agent loop (`session.interrupt`, observed on opencode 2.2.7); the returned function
// stops listening.
function stopOnAbort(ctx: V2Context, sessionID: string, signal: AbortSignal | undefined): () => void {
  const stop = () => {
    ctx.session.interrupt({ sessionID }).catch(() => undefined)
  }
  signal?.addEventListener('abort', stop, { once: true })
  return () => signal?.removeEventListener('abort', stop)
}

export function v2Host(ctx: V2Context, pollMs = POLL_MS): Host {
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
      const unlisten = stopOnAbort(ctx, session.id, req.signal)
      try {
        await ctx.session.prompt({ sessionID: session.id, text: req.prompt })
        return await awaitReply(ctx, session.id, pollMs, req.signal)
      } finally {
        unlisten()
      }
    },
    // The session's own model, set at creation or by a switch (observed on opencode 2.2.7); none when it has none.
    async callerModel(sessionID) {
      const model = (await ctx.session.get({ sessionID })).model
      return model ? { providerID: model.providerID, modelID: model.id } : undefined
    },
  }
}

export function v2Tool(host: Host, spec: ToolSpec): V2ToolDefinition {
  const properties = Object.fromEntries(Object.keys(spec.args).map(k => [k, { type: 'string' }]))
  const required = Object.entries(spec.args)
    .filter(([, a]) => !a.optional)
    .map(([k]) => k)
  return {
    name: spec.name,
    description: spec.description,
    input: { type: 'object', properties, required, additionalProperties: false },
    execute: async (input, call) => {
      const answer = await spec.run(host, stringArgs(spec, input), { sessionID: call.sessionID, signal: call.signal })
      return { content: [{ type: 'text', text: typeof answer === 'string' ? answer : answer.output }] }
    },
  }
}

async function pump(events: AsyncIterator<V2Event>, work: WorkHook): Promise<void> {
  for (let next = await events.next(); !next.done; next = await events.next()) {
    const { type, data } = next.value
    if (type === 'session.created' && data.parentID) work.childCreated(data.sessionID, data.parentID, data.agent)
    else if (type === 'session.compaction.ended') await work.compacted(data.sessionID)
  }
}

// The work hook on 2.x. There is no `chat.message`: the closest mechanism is the session `prompt` hook, which
// sees the prompt's text before it is admitted and may rewrite it, so the lines are appended to the prompt
// itself (they become part of the user's message, not a separate synthetic part).
async function hookWork(ctx: V2Context, work: WorkHook): Promise<() => Promise<void>> {
  const reg = await ctx.session.hook('prompt', input =>
    work.message(input.sessionID, input.prompt.text, undefined, text => {
      input.prompt.text = `${input.prompt.text}\n\n${text}`
      return true
    }),
  )
  const events = ctx.event.subscribe({ types: ['session.created', 'session.compaction.ended'] })[Symbol.asyncIterator]()
  pump(events, work).catch(() => {
    /* silence: the hook never costs the tools (realm @nick/craft, #276) */
  })
  return async () => {
    await reg.dispose()
    await events.return?.()
  }
}

/** Everything the 2.x runtime gets from `setup()`: the tools and the work hook; resolves to their disposer. */
export async function v2Setup(ctx: V2Context, tools: readonly ToolSpec[], work: WorkHook): Promise<() => Promise<void>> {
  const host = v2Host(ctx)
  const toolReg = await ctx.tool.transform(editor => {
    for (const spec of tools) editor.add(v2Tool(host, spec))
  })
  const unhook = await hookWork(ctx, work).catch(() => async () => {})
  return async () => {
    await toolReg.dispose()
    await unhook()
  }
}
