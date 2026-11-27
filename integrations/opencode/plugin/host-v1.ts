// The 1.x side of the host (host.ts): the plugin input's SDK `client` runs child sessions, `tool()` registers
// the tools, and `event` / `chat.message` feed the work hook. The client calls are held to a narrow local
// shape rather than the SDK's generated types: the shapes below are the ones the plugin has always sent
// (opencode 1.x SDK docs), and the response is read defensively across the shapes a session may return.
import type { Hooks, PluginInput } from '@opencode-ai/plugin'
import { tool } from '@opencode-ai/plugin'
import type { Part, TextPart } from '@opencode-ai/sdk'
import type { Host, ToolSpec, WorkHook } from './host.ts'
import { agentNames, extractText, lastModel } from './host-v1-read.ts'
import { runV1Child } from './host-v1-child.ts'
import { runV1Tool, type V1Toast } from './host-v1-progress.ts'
import { lightenSystem } from './light-agent-v1.ts'
import { oncePerReason, reasonOf } from './light-agent-shared.ts'
import { shellIn } from './shell.mjs'

export { extractText, lastModel }

type TextIn = { type: 'text'; text: string }
export interface V1Client {
  tui?: V1Toast
  app: { agents(): Promise<unknown> }
  session: {
    create(req: { body: { title: string; parentID?: string } }): Promise<unknown>
    messages(req: { path: { id: string } }): Promise<unknown>
    abort(req: { path: { id: string } }): Promise<unknown>
    prompt(req: { path: { id: string }; body: { agent: string; parts: TextIn[]; model?: { providerID: string; modelID: string } } }): Promise<unknown>
  }
}

export function v1Host(input: { client: V1Client; directory: string; worktree: string }): Host {
  const { client, directory, worktree } = input
  return {
    directory,
    worktree,
    sh: shellIn(directory),
    runChild: req => runV1Child(client, req),
    async callerModel(sessionID) {
      return lastModel(await client.session.messages({ path: { id: sessionID } }))
    },
    async agents() {
      return agentNames(await client.app.agents())
    },
  }
}

function v1Tool(host: Host, spec: ToolSpec, client: V1Client, log: (line: string) => void) {
  const args = Object.fromEntries(Object.entries(spec.args).map(([k, a]) => [k, a.optional ? tool.schema.string().optional() : tool.schema.string()]))
  return tool({
    description: spec.description,
    args,
    execute: (raw, context) => runV1Tool(host, spec, raw, context, client.tui, log),
  })
}

// The words the human (or the parent agent) wrote: the message's own text parts.
function promptOf(parts: Part[]): string {
  return parts
    .filter((p): p is TextPart => p.type === 'text' && !p.synthetic && !p.ignored)
    .map(p => p.text)
    .join('\n')
}

// The added part sorts after the message's last one: an id built on that part's own.
function syntheticPart(parts: Part[], text: string): TextPart | null {
  const last = parts.at(-1)
  if (!last || typeof last.id !== 'string') return null
  return { id: `${last.id}-craft`, sessionID: last.sessionID, messageID: last.messageID, type: 'text', text, synthetic: true }
}

/** The work hook on 1.x: `event` names subagent sessions and compactions, `chat.message` gains a synthetic part. */
export function v1WorkHooks(work: WorkHook): Required<Pick<Hooks, 'event' | 'chat.message'>> {
  return {
    async event({ event }) {
      try {
        if (event.type === 'session.created' && event.properties.info.parentID) {
          work.childCreated(event.properties.info.id, event.properties.info.parentID)
        } else if (event.type === 'session.compacted') {
          await work.compacted(event.properties.sessionID)
        }
      } catch {
        /* silence */
      }
    },
    async 'chat.message'(input, output) {
      try {
        const parts = output.parts
        await work.message(
          input.sessionID,
          promptOf(parts),
          input.agent,
          text => {
            const part = syntheticPart(parts, text)
            if (part) parts.push(part)
            return part !== null
          },
          syntheticPart(parts, '') !== null,
        )
      } catch {
        /* silence */
      }
    },
  }
}

// Everything the 1.x runtime gets from `server()`: the tools, the work hook and the review-task agent's system text
// lightened in place (light-agent-v1.ts) — a throw inside that hook is caught and said once per reason on `log`
// (realm @nick/craft, node #707).
export function v1Hooks(
  input: Pick<PluginInput, 'directory' | 'worktree'> & { client: unknown },
  tools: readonly ToolSpec[],
  work: WorkHook,
  log: (line: string) => void = console.error,
): Hooks {
  const host = v1Host({ client: input.client as V1Client, directory: input.directory, worktree: input.worktree })
  const say = oncePerReason(log)
  return {
    ...v1WorkHooks(work),
    tool: Object.fromEntries(tools.map(t => [t.name, v1Tool(host, t, input.client as V1Client, log)])),
    'experimental.chat.system.transform': (_input, output) => {
      try {
        lightenSystem(output.system)
      } catch (e) {
        say(reasonOf(e))
      }
      return Promise.resolve()
    },
  }
}
