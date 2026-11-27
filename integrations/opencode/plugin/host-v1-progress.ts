// 1.19.6 does not render a running custom tool's title. Its native toast is the visible channel (#503, realm @nick/craft).
import type { ToolContext } from '@opencode-ai/plugin'
import { stringArgs, type Host, type ToolSpec } from './host.ts'
import { errorOf } from './host-v1-read.ts'

export interface V1Toast {
  showToast(input: { body: { title: string; message: string; variant: 'info'; duration: number }; signal: AbortSignal }): Promise<unknown>
}

type Notice = { message: string; duration: number }

async function deliver(tui: V1Toast, notice: Notice): Promise<void> {
  const stop = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        stop.abort()
        reject(new Error('TUI notification timed out'))
      }, 2000)
    })
    const result = await Promise.race([tui.showToast({ body: { title: 'craft review', variant: 'info', ...notice }, signal: stop.signal }), timeout])
    const error = errorOf(result)
    if (error) throw new Error(error)
  } finally {
    clearTimeout(timer)
  }
}

function notifier(tui: V1Toast, log: (line: string) => void) {
  let pending: Notice | undefined
  let flight: Promise<void> | undefined
  let latest = ''
  let ended = false
  let warned = false
  let renewal: ReturnType<typeof setInterval> | undefined
  const drain = async () => {
    while (pending) {
      const notice = pending
      pending = undefined
      try {
        await deliver(tui, notice)
      } catch (error) {
        if (!warned) log(`craft: review progress could not be shown: ${error instanceof Error ? error.message : String(error)}`)
        warned = true
      }
    }
  }
  const enqueue = (message: string, duration: number) => {
    pending = { message, duration }
    flight ??= drain().finally(() => {
      flight = undefined
    })
    return flight
  }
  return {
    update(message: string) {
      if (ended) return
      const changed = message !== latest
      latest = message
      renewal ??= setInterval(() => {
        void enqueue(latest, 10000)
      }, 5000)
      if (changed) void enqueue(message, 10000)
    },
    async finish(message: string) {
      ended = true
      clearInterval(renewal)
      await enqueue(message, 5000)
    },
  }
}

/** Metadata stays available to other clients; the review alone also shows a finite, renewed TUI notice. */
export async function runV1Tool(host: Host, spec: ToolSpec, raw: unknown, context: ToolContext, tui?: V1Toast, log = console.error) {
  const notice = spec.name === 'review' && tui ? notifier(tui, log) : undefined
  if (spec.name === 'review' && !tui) log('craft: review progress could not be shown: this host has no TUI notification API')
  let end = 'craft review: failed'
  try {
    const answer = await spec.run(host, stringArgs(spec, raw), {
      sessionID: context.sessionID,
      signal: context.abort,
      progress: title => {
        context.metadata({ title })
        notice?.update(title)
      },
    })
    end = typeof answer === 'string' ? 'craft review: finished' : answer.title
    return answer
  } finally {
    await notice?.finish(context.abort.aborted ? 'craft review: stopped' : end)
  }
}
