// The 2.x side of the host (host.ts), on the surface opencode-v2.d.ts pins: `ctx.session` runs child sessions,
// `ctx.tool` registers the tools with a JSON Schema input (no Effect, no zod: 2.2.7 accepts plain JSON Schema),
// and the session `prompt` hook plus `ctx.event` feed the work hook.
import { stringArgs, type ChildRequest, type Host, type ModelRef, type ToolSpec, type WorkHook } from './host.ts'
import type { V2Context, V2Event, V2Message, V2ModelRef, V2ToolDefinition } from './opencode-v2.js'
import { shellIn } from './shell.mjs'
import { progressChannel, withProgress, type Say } from './progress-rpc.ts'

// How long to wait between reads of a child session that is not yet done, and how many reads before giving
// up. The orchestrator's own deadline (orchestrator.ts) is the real bound; this only keeps the loop from
// outliving it by much.
const POLL_MS = 500
const MAX_POLLS = 3 * 60 * 60 * 2

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * A child session whose agent loop did not succeed: the runtime's error by its type and message when it failed
 * (realm @nick/craft, node #626), else the outcome it ended with (`interrupted`, or one this reader does not know).
 */
export class ChildSessionFailed extends Error {
  constructor(
    readonly type: string,
    readonly detail: string,
  ) {
    super(`the child session failed (${type})${detail ? `: ${detail}` : ''}`)
    this.name = 'ChildSessionFailed'
  }
}

const textOf = (message: V2Message | undefined) =>
  (message?.content ?? [])
    .filter(c => c.type === 'text' && typeof c.text === 'string')
    .map(c => c.text)
    .join('\n')
    .trim()

// The outcome an idle entry has when the loop succeeded; 2.2.7's are `succeeded`, `failed` and `interrupted` (read from
// its session schema, realm @nick/craft, node #627).
const SUCCEEDED = 'succeeded'

// The session's reply once its agent loop is idle: the text of the last assistant message before the `idle` entry that
// ends the context (observed on 2.2.7, realm @nick/craft, node #626), "" when it said nothing; null while that entry is
// not there, the loop still running. An assistant message alone is no reply: one that ends a step mid-loop looks finished
// too. Only a succeeded loop has a reply: a failed one throws its error, any other outcome throws that outcome.
export function finishedReply(messages: readonly V2Message[]): string | null {
  const last = messages.at(-1)
  if (last?.type !== 'idle') return null
  if (last.outcome === 'failed') throw new ChildSessionFailed(last.error?.type || 'unknown', last.error?.message ?? '')
  if (last.outcome !== SUCCEEDED) throw new ChildSessionFailed(`outcome ${last.outcome ?? 'none'}`, 'the agent loop ended without succeeding')
  return textOf([...messages].reverse().find(m => m.type === 'assistant'))
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

// `wait` resolves at once on 2.2.7 (realm @nick/craft, node #626), so the context is read until its `idle` entry says the
// loop ended; between reads the loop pauses `pollMs`. An abort (the
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

/** A model as 2.x names it, its variant kept. */
const v2Model = (m: ModelRef): V2ModelRef => ({ providerID: m.providerID, id: m.modelID, ...(m.variant ? { variant: m.variant } : {}) })

/** What `session.create` is given for a child: only what the request names. */
const createInput = (req: ChildRequest) => ({
  title: req.title,
  ...(req.agent ? { agent: req.agent } : {}),
  ...(req.model ? { model: v2Model(req.model) } : {}),
  ...(req.parentID ? { parentID: req.parentID } : {}),
})

export function v2Host(ctx: V2Context, pollMs = POLL_MS): Host {
  const directory = ctx.location.directory
  return {
    directory,
    worktree: ctx.location.project?.directory ?? directory,
    sh: shellIn(directory),
    async runChild(req) {
      // A task already given up is never started; one given up while its session was made is never prompted.
      if (req.signal?.aborted) throw new Error(STOPPED)
      const session = await ctx.session.create(createInput(req))
      req.onSession?.(session.id)
      if (req.signal?.aborted) throw new Error(STOPPED)
      const unlisten = stopOnAbort(ctx, session.id, req.signal)
      try {
        await ctx.session.prompt({ sessionID: session.id, text: req.prompt })
        return await awaitReply(ctx, session.id, pollMs, req.signal)
      } catch (e) {
        // A loop that ended failed needs no stop; any other break leaves no child running behind the caller's retry.
        if (!(e instanceof ChildSessionFailed)) await ctx.session.interrupt({ sessionID: session.id }).catch(() => undefined)
        throw e
      } finally {
        unlisten()
      }
    },
    async agents() {
      return (await ctx.agent.list()).data.map(a => a.id)
    },
    // The session's own model, set at creation or by a switch (observed on opencode 2.2.7); none when it has none.
    async callerModel(sessionID) {
      const model = (await ctx.session.get({ sessionID })).model
      return model ? { providerID: model.providerID, modelID: model.id, ...(model.variant ? { variant: model.variant } : {}) } : undefined
    },
  }
}

// `say` carries the call's progress to the TUI's footer (progress-rpc.ts; realm @nick/craft, node #512).
export function v2Tool(host: Host, spec: ToolSpec, say?: Say): V2ToolDefinition {
  const properties = Object.fromEntries(Object.keys(spec.args).map(k => [k, { type: 'string' }]))
  const required = Object.entries(spec.args)
    .filter(([, a]) => !a.optional)
    .map(([k]) => k)
  return {
    name: spec.name,
    description: spec.description,
    input: { type: 'object', properties, required, additionalProperties: false },
    execute: async (input, call) => {
      const answer = await withProgress(spec.name, say, call.sessionID, progress =>
        spec.run(host, stringArgs(spec, input), { sessionID: call.sessionID, signal: call.signal, ...(progress ? { progress } : {}) }),
      )
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
  const channel = await progressChannel(ctx)
  const toolReg = await ctx.tool.transform(editor => {
    for (const spec of tools) editor.add(v2Tool(host, spec, channel.say))
  })
  const unhook = await hookWork(ctx, work).catch(() => async () => {})
  return async () => {
    await toolReg.dispose()
    await unhook()
    await channel.dispose()
  }
}
