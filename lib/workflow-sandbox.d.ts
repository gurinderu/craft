// The globals the Workflow tool's sandbox hands an engine script, as the tool documents them (the
// workflow-authoring reference; realm @nick/craft, node #134). lib/engine-harness.mjs reproduces the
// same eight for tests. `args` stays `unknown` where the reference says `any`: every engine normalises
// it before use, so the stricter type costs nothing and catches a read before normalisation.
// Every option is optional; an explicit `undefined` reads as absent, as an options bag does.
type AgentOptions = {
  label?: string | undefined, phase?: string | undefined, schema?: object | undefined, model?: string | undefined,
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined, isolation?: 'worktree' | undefined, agentType?: string | undefined,
}
declare const args: unknown
/** Without `schema`, the subagent's final text; with it, the validated object; `null` if the agent was skipped or died. */
declare function agent(prompt: string, opts?: AgentOptions): Promise<any>
/** A barrier; a thunk that throws resolves to `null` in its slot, and the call itself never rejects. */
declare function parallel<T>(thunks: Array<() => T | Promise<T>>): Promise<Array<Awaited<T> | null>>
/** Each item through every stage, no barrier; a stage that throws drops that item to `null`. */
declare function pipeline(items: unknown[], ...stages: Array<(prev: any, item: any, index: number) => unknown>): Promise<any[]>
declare function phase(title: string): void
declare function log(message: string): void
/** Runs another workflow inline; one level only; throws on an unknown name. */
declare function workflow(nameOrRef: string | { scriptPath: string }, args?: unknown): Promise<any>
/** `total` is null when no token target was set; `remaining()` is then Infinity. */
declare const budget: { total: number | null, spent(): number, remaining(): number }
// Beyond the eight: the timers review.js relies on — a probe workflow saw setTimeout/clearTimeout
// defined, and TextEncoder, TextDecoder, process and require undefined (realm @nick/craft, #135).
declare function setTimeout(callback: () => void, ms?: number): unknown
declare function clearTimeout(handle: unknown): void
