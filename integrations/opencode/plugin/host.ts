// The host interface: everything craft's OpenCode workflows need from OpenCode, and nothing else. Two sides
// implement it — host-v1.ts on the 1.x plugin API (the SDK `client` and `tool()`), host-v2.ts on the 2.x one
// (`ctx.tool`, `ctx.session`, `ctx.event`) — and index.ts hands each runtime its own side from one module.
// The workflows (orchestrator, rust-audit, triage-findings, the review driver) and the work hook's core
// see only these types, so they are tested once, against a fake host.

// A model as both runtimes name it: OpenCode's `providerID/modelID`. Absent means the session's own model.
export interface ModelRef {
  providerID: string
  modelID: string
}

export interface ChildRequest {
  // Shown as the child session's title.
  title: string
  // An OpenCode agent's name; "" means the default agent of a new session.
  agent: string
  prompt: string
  model?: ModelRef
  // Called with the child session's id as soon as it exists, before the prompt runs.
  onSession?: (id: string) => void
}

// Where the workflows run and how they read it. `sh` runs one read-only probe through `bash -lc` in
// `directory` and returns its trimmed stdout, or "" when it failed (shell.mjs; both sides share it).
export interface Workspace {
  readonly directory: string
  readonly worktree: string
  sh(cmd: string): Promise<string>
}

export interface Host extends Workspace {
  // Run one child session to its end and return its final text ("" when it said nothing). Throws when the
  // runtime refuses the session; a hang is the caller's to bound (orchestrator.ts).
  runChild(req: ChildRequest): Promise<string>
}

// A tool both runtimes register. Every argument is a string; each side builds its own schema from `args`.
export interface ToolSpec {
  name: string
  description: string
  args: Record<string, { optional: boolean; description?: string }>
  run(host: Host, args: Record<string, string | undefined>): Promise<string>
}

// craft's hook at the moment of work, as the runtimes feed it (work-hook.ts). `deliver` places the lines the
// hook wants said into the message and answers whether it could.
export interface WorkHook {
  childCreated(id: string, parent: string, agent?: string): void
  compacted(session: string): Promise<void>
  message(session: string, prompt: string, agent: string | undefined, deliver: (text: string) => boolean): Promise<void>
}

// The tool's arguments as the runtime hands them over: only the declared string fields survive.
export function stringArgs(spec: ToolSpec, input: unknown): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {}
  for (const key of Object.keys(spec.args)) {
    const value = record[key]
    out[key] = typeof value === "string" ? value : undefined
  }
  return out
}
