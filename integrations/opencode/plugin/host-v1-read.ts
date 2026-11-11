// What the 1.x SDK's responses carry, read defensively across the shapes a session may return (host-v1.ts).
import type { ModelRef } from "./host.ts"

export const field = (v: unknown, k: string): unknown => (typeof v === "object" && v !== null ? (v as Record<string, unknown>)[k] : undefined)

// The parts of a message, wherever the response shape keeps them.
function partsOf(root: unknown): unknown[] {
  const found = [field(root, "parts"), field(field(root, "data"), "parts"), field(field(root, "message"), "parts")].find(Array.isArray)
  return found ?? []
}

export function extractText(res: unknown): string {
  // Normalize a streaming/array response to its last message before reading parts, so an array
  // shape isn't mistaken for "no output" (which would mis-mark a successful job NOT RUN).
  const root: unknown = Array.isArray(res) ? res[res.length - 1] : res
  const text = partsOf(root)
    .filter((p) => field(p, "type") === "text" && typeof field(p, "text") === "string")
    .map((p) => String(field(p, "text")))
    .join("\n")
    .trim()
  const top = field(root, "text")
  return text || (typeof top === "string" ? top.trim() : "")
}

// The model a session's newest message names (observed on opencode 1.19.5): a user message's `model`, an assistant
// message's `providerID`/`modelID`.
export function lastModel(res: unknown): ModelRef | undefined {
  const list = field(res, "data") ?? res
  const infos = Array.isArray(list) ? list.map((m) => field(m, "info")) : []
  for (const info of infos.reverse()) {
    const own = field(info, "model")
    const providerID = field(own, "providerID") ?? field(info, "providerID")
    const modelID = field(own, "modelID") ?? field(info, "modelID")
    if (typeof providerID === "string" && typeof modelID === "string") return { providerID, modelID }
  }
  return undefined
}

// The agents' names an `app.agents()` answer lists (observed on opencode 1.19.5: `{ data: [{ name }] }`).
export function agentNames(res: unknown): Set<string> {
  const list = field(res, "data") ?? res
  return new Set((Array.isArray(list) ? list : []).map((a) => field(a, "name")).filter((n): n is string => typeof n === "string"))
}

// What a prompt that failed answered: 1.19.5 answers an unknown agent with `{ error: { name, data: { message } } }`
// rather than throwing (observed), so the error is lifted out; '' when the answer is no error.
export function errorOf(res: unknown): string {
  const error = field(res, "error")
  if (error === undefined || error === null) return ""
  const message = field(field(error, "data"), "message") ?? field(error, "message") ?? field(error, "name")
  return typeof message === "string" && message ? message : "the prompt failed"
}
