// The part of OpenCode's 2.x server-plugin surface this plugin uses, written by hand: no published package
// types it. npm's @opencode-ai/plugin is 1.x (latest 1.19.5), and the dev snapshot's `v2/promise`
// PluginContext lacks `tool`, `session` and `event`. Read from the opencode 2.2.7 binary
// (nix opencode2-2.2.7: the plugin loader's `{id, effect} | {id, setup}` check and the promise-side context
// it builds) and observed by a probe plugin loaded in `opencode serve` 2.2.7: the context's keys, a session
// created (nested by `parentID`, with a model) and read back, an admitted prompt, the `prompt` hook rewriting its text, a JSON Schema tool added
// and executed, `session.created` events, and the `context` hook changing a model request in place (realm @nick/craft,
// node #697); a child session's reply and failure after a real agent loop were observed later (node #626), and the
// `compaction` hook carrying the same input for the request that summarizes a session (node #697). Re-read this against
// the binary on each 2.x bump.

import type { V2AgentDraft, V2CommandDefinition, V2Skill } from './opencode-v2-editors.js'

export interface V2Registration {
  dispose(): Promise<void>
}

// A tool's input may be a JSON Schema object: the host passes it to the model as `inputSchema` and converts
// it to validate the call (it also takes a Standard Schema with `~standard.jsonSchema`, or an Effect schema).
export interface V2ToolDefinition {
  name: string
  description: string
  input: Record<string, unknown>
  execute(
    input: unknown,
    context: { sessionID: string; messageID: string; id: string; agent: string; signal: AbortSignal },
  ): Promise<{
    content: { type: 'text'; text: string }[]
  }>
}

export interface V2ModelRef {
  providerID: string
  id: string
  variant?: string
}

export interface V2Session {
  id: string
  parentID?: string
  // Present once set: at creation or by `switchModel` (observed).
  model?: V2ModelRef
  agent?: string
  title?: string
}

// A session's context entries as 2.2.7 returns them (observed, realm @nick/craft, node #626): the messages, then — once
// the agent loop is done — an `idle` entry whose `outcome` is `succeeded`, `failed` (with the runtime's `error` beside
// it) or `interrupted`, the three its session schema names (read from the 2.2.7 binary, node #627). Only `assistant` and
// `idle` are read.
export interface V2Message {
  type: string
  content?: { type: string; text?: string }[]
  finish?: string
  time?: { created: number; completed?: number }
  outcome?: string
  error?: { type?: string; message?: string }
}

export interface V2PromptHookInput {
  sessionID: string
  messageID: string
  // Mutable: the host reads `prompt.text` back after the hook, so rewriting it changes what is admitted.
  prompt: { text: string }
  delivery: string
}

// A system part of a model request as 2.2.7 hands it to the `context` hook (observed by a probe, realm @nick/craft,
// node #697): the agent's prompt, a `# Your Model` note, the repository's instructions and a worktree note. Only the
// instructions part carried metadata: each of its sections under `experimental.instructions` as `{key, text}`, its text
// their texts joined by blank lines (node #698).
export interface V2SystemPart {
  type: string
  text: string
  metadata?: { experimental?: { instructions?: { key: string; text: string }[] } }
}

// A message of the same request: a user message (the task; or a rule file the host loaded on the way, its text
// beginning `Instructions from: `), an assistant message, a tool result, or a `system` message — an instruction
// change's notice — of text parts.
export interface V2ModelMessage {
  id?: string
  role: string
  content: string | { type: string; text?: string }[]
}

// The `context` hook's input, and the `compaction` and `generate` hooks' with the same keys (2.2.7, node #697): a
// model request on its way out. Mutable, and only that: the host keeps what the hook changes in place and drops what
// it returns (2.2.7, node #697). `tools` is a record of name → definition.
export interface V2ContextHookInput {
  sessionID: string
  agent: string
  model: V2ModelRef
  options: Record<string, unknown>
  system?: V2SystemPart[]
  messages?: V2ModelMessage[]
  tools?: Record<string, unknown>
}

export interface V2Event {
  type: string
  data: { sessionID: string; parentID?: string; agent?: string }
}

// The RPC surface (`ctx.rpc`), observed on 2.2.7 by a probe plugin: `register` resolves to a registration whose
// `events.emit(name, data)` publishes `rpc.<id>.<name>` on the server's event stream, where the TUI's
// `client.rpc(def).events.on(name, …)` hears it; an event's `schema` may be plain JSON Schema. Internal to 2.x and
// optional here: an older or newer 2.x may not have it. Re-read on each 2.x bump.
export interface V2RpcDefinition {
  id: string
  methods: Record<string, unknown>
  events: Record<string, { schema: Record<string, unknown> }>
}

export interface V2RpcRegistration extends V2Registration {
  events: { emit(event: string, data: unknown): Promise<void> }
}

type V2Transform<Editor> = (edit: (editor: Editor) => void) => Promise<V2Registration>

export interface V2Context {
  rpc?: {
    register(definition: V2RpcDefinition, handlers: Record<string, unknown>): Promise<V2RpcRegistration>
  }
  app: { version: string }
  location: { directory: string; project?: { directory?: string } }
  agent: {
    list(): Promise<{ data: { id: string }[] }>
    transform: V2Transform<{ update(id: string, edit: (draft: V2AgentDraft) => void): void }>
  }
  command: {
    transform: V2Transform<{ add(definition: V2CommandDefinition): void }>
  }
  skill: {
    transform: V2Transform<{ add(skill: V2Skill): void }>
  }
  tool: {
    transform(edit: (editor: { add(definition: V2ToolDefinition): void }) => void): Promise<V2Registration>
  }
  session: {
    // A child (`parentID`) is made where its parent is: the plugin's `create` passes a `location` only to a session with
    // no parent (read from the 2.2.7 binary, realm @nick/craft, node #627), so no child can be put in another directory.
    create(input: { title?: string; agent?: string; model?: V2ModelRef; parentID?: string }): Promise<V2Session>
    get(input: { sessionID: string }): Promise<V2Session>
    // Admits the input and schedules the agent loop (`resume: false` admits it without running the loop).
    prompt(input: { sessionID: string; text: string; resume?: boolean; delivery?: string }): Promise<unknown>
    // Experimental in 2.2.7: documented to resolve when the loop is idle, observed resolving `{}` at once (node #626).
    wait(input: { sessionID: string }): Promise<unknown>
    // Stops the session's agent loop; `{ interrupted: false }` when it was idle (observed).
    interrupt(input: { sessionID: string }): Promise<unknown>
    context(input: { sessionID: string }): Promise<V2Message[]>
    hook(name: 'prompt', callback: (input: V2PromptHookInput) => Promise<void> | void): Promise<V2Registration>
    // Experimental in 2.2.7: the agent's own model requests (`context`), the request that summarizes a session for the
    // agent (`compaction`) and a request the session is asked outside its steps (`generate`), before they go out, changed
    // in place; the summarizer's instruction is appended after the hook (light-agent.ts, node #697).
    hook(name: 'context' | 'compaction' | 'generate', callback: (input: V2ContextHookInput) => Promise<void> | void): Promise<V2Registration>
  }
  event: {
    // Returned synchronously; an async iterable of the location's events, filtered by type.
    subscribe(options: { types: string[] }): AsyncIterable<V2Event>
  }
}
