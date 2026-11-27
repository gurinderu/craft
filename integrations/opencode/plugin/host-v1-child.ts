// The 1.x SDK child lifecycle (realm @nick/craft, nodes #719, #627).
import { ChildSessionFailed, type ChildRequest } from './host.ts'
import type { V1Client } from './host-v1.ts'
import { errorOf, extractText, field, turnError } from './host-v1-read.ts'

const STOPPED = 'the child session was stopped at its deadline'
const STOP_MS = 10_000

// Register before calling the SDK: it can abort synchronously. The race also handles late rejections.
async function untilAbort<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let onAbort = () => {}
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error(STOPPED))
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        if (signal?.aborted) throw new Error(STOPPED)
        return work()
      }),
      aborted,
    ])
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

// A stop is confirmed only by the SDK's boolean reply, not merely a resolved HTTP request.
async function stopChild(client: V1Client, id: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = Symbol('unconfirmed stop')
  const deadline = new Promise<typeof late>(resolve => {
    timer = setTimeout(() => resolve(late), STOP_MS)
  })
  try {
    const response = await Promise.race([Promise.resolve().then(() => client.session.abort({ path: { id } })), deadline])
    if (response === late) throw new Error(`did not confirm its stop within ${String(STOP_MS)} ms`)
    const failed = errorOf(response)
    if (failed) throw new Error(failed)
    if (response !== true && field(response, 'data') !== true) throw new Error('the server did not confirm the stop')
  } catch (e) {
    console.error(`craft: child session ${id} could not be stopped (${e instanceof Error ? e.message : String(e)}); it may still be running`)
  } finally {
    clearTimeout(timer)
  }
}

async function prompted(client: V1Client, id: string, req: ChildRequest): Promise<string> {
  const model = req.model && { providerID: req.model.providerID, modelID: req.model.modelID }
  const res = await untilAbort(
    () =>
      client.session.prompt({
        path: { id },
        body: { agent: req.agent, parts: [{ type: 'text', text: req.prompt }], ...(model ? { model } : {}) },
      }),
    req.signal,
  )
  if (req.signal?.aborted) throw new Error(STOPPED)
  const failed = errorOf(res)
  if (failed) throw new Error(failed)
  const turn = turnError(res)
  if (turn) throw new ChildSessionFailed(turn.type, turn.message)
  return extractText(res)
}

export async function runV1Child(client: V1Client, req: ChildRequest): Promise<string> {
  let id: string | undefined
  let stopping: Promise<void> | undefined
  const stop = () => {
    if (id === undefined) return Promise.resolve()
    return (stopping ??= stopChild(client, id))
  }
  const create = async () => {
    const session = await client.session.create({ body: { title: req.title, ...(req.parentID ? { parentID: req.parentID } : {}) } })
    const found = field(session, 'id') ?? field(field(session, 'data'), 'id')
    if (typeof found !== 'string') throw new Error(errorOf(session) || 'OpenCode did not return a child session ID')
    id = found
    // Cancellation can finish runChild before create responds. Stop that exact late ID without publishing it.
    if (req.signal?.aborted) {
      await stop()
      throw new Error(STOPPED)
    }
    return found
  }
  try {
    const sessionID = await untilAbort(create, req.signal)
    req.onSession?.(sessionID)
    const text = await prompted(client, sessionID, req)
    if (!text) await stop()
    return text
  } catch (e) {
    // A failed agent loop already ended. Every other failure stops the known child before a retry can start.
    if (!(e instanceof ChildSessionFailed)) await stop()
    throw e
  }
}
