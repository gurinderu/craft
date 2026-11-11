// The part of OpenCode's 2.x server-plugin surface this plugin uses, written by hand: no published package
// types it. npm's @opencode-ai/plugin is 1.x (latest 1.19.5), and the dev snapshot's `v2/promise`
// PluginContext lacks `tool`, `session` and `event`. Read from the opencode 2.2.7 binary
// (nix opencode2-2.2.7: the plugin loader's `{id, effect} | {id, setup}` check and the promise-side context
// it builds) and observed by a probe plugin loaded in `opencode serve` 2.2.7: the context's keys, a session
// created (nested by `parentID`, with a model) and read back, an admitted prompt, the `prompt` hook rewriting its text, a JSON Schema tool added
// and executed, and `session.created` events. What no probe could reach without a model — a child session's
// reply after a real agent loop — is marked UNOBSERVED. Re-read this against the binary on each 2.x bump.

export interface V2Registration {
  dispose(): Promise<void>
}

// A tool's input may be a JSON Schema object: the host passes it to the model as `inputSchema` and converts
// it to validate the call (it also takes a Standard Schema with `~standard.jsonSchema`, or an Effect schema).
export interface V2ToolDefinition {
  name: string
  description: string
  input: Record<string, unknown>
  execute(input: unknown, context: { sessionID: string; messageID: string; id: string; agent: string; signal: AbortSignal }): Promise<{
    content: { type: "text"; text: string }[]
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

// UNOBSERVED in a real loop: the message union as 2.2.7's schema spells it; only `assistant` is read.
export interface V2Message {
  type: string
  content?: { type: string; text?: string }[]
  finish?: string
  time?: { created: number; completed?: number }
}

export interface V2PromptHookInput {
  sessionID: string
  messageID: string
  // Mutable: the host reads `prompt.text` back after the hook, so rewriting it changes what is admitted.
  prompt: { text: string }
  delivery: string
}

export interface V2Event {
  type: string
  data: { sessionID: string; parentID?: string; agent?: string }
}

export interface V2Context {
  app: { version: string }
  location: { directory: string; project?: { directory?: string } }
  agent: {
    list(): Promise<{ data: { id: string }[] }>
  }
  tool: {
    transform(edit: (editor: { add(definition: V2ToolDefinition): void }) => void): Promise<V2Registration>
  }
  session: {
    create(input: { title?: string; agent?: string; model?: V2ModelRef; parentID?: string }): Promise<V2Session>
    get(input: { sessionID: string }): Promise<V2Session>
    // Admits the input and schedules the agent loop (`resume: false` admits it without running the loop).
    prompt(input: { sessionID: string; text: string; resume?: boolean }): Promise<unknown>
    // Experimental in 2.2.7: resolves when the session's agent loop is idle.
    wait(input: { sessionID: string }): Promise<unknown>
    // Stops the session's agent loop; `{ interrupted: false }` when it was idle (observed).
    interrupt(input: { sessionID: string }): Promise<unknown>
    context(input: { sessionID: string }): Promise<V2Message[]>
    hook(name: "prompt", callback: (input: V2PromptHookInput) => Promise<void> | void): Promise<V2Registration>
  }
  event: {
    // Returned synchronously; an async iterable of the location's events, filtered by type.
    subscribe(options: { types: string[] }): AsyncIterable<V2Event>
  }
}
