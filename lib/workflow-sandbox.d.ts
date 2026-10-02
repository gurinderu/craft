// The globals the Workflow tool's sandbox hands an engine script — the eight lib/engine-harness.mjs
// supplies to reproduce it (realm @nick/craft, node #134). Model output and the caller's args are not
// typed beyond what the engine itself checks; agent options are an open record, not a guessed schema.
declare const args: unknown
declare function agent(prompt: string, opts?: Record<string, unknown>): Promise<any>
declare function parallel<T>(thunks: Array<() => T | Promise<T>>, opts?: Record<string, unknown>): Promise<Array<Awaited<T>>>
declare function pipeline(items: unknown[], ...stages: Array<(x: any) => unknown>): Promise<any[]>
declare function phase(title: string): void
declare function log(...parts: unknown[]): void
declare function workflow(name: string, args?: unknown): Promise<any>
declare const budget: { total: number, spent(): number, remaining(): number }
