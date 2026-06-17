// Deterministic child-session fan-out with a sequential fallback for opencode's known
// child-session execution bugs (anomalyco/opencode #8528, sst/opencode #6573): if a child
// session is created but never executes within STUCK_MS, retry the failed jobs one at a time;
// if a job still yields nothing, surface a clear, actionable error rather than hang.
//
// Signatures (client.session.create / client.session.prompt) follow the opencode SDK docs;
// `tsc` will flag any mismatch against the installed @opencode-ai/sdk types — adjust there.
import type { PluginCtx } from "./index.ts"

const STUCK_MS = 90_000

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | { __timeout: true }> {
  return Promise.race([p, new Promise<{ __timeout: true }>((r) => setTimeout(() => r({ __timeout: true }), ms))])
}

// Spawn one child session bound to a hidden agent and return its final text.
export async function runAgent(ctx: PluginCtx, agentName: string, prompt: string): Promise<string> {
  const session = await ctx.client.session.create({ body: { title: `craft:${agentName}` } })
  const path = { id: session.id ?? session.data?.id }
  const res = await ctx.client.session.prompt({
    path,
    body: { agent: agentName, parts: [{ type: "text", text: prompt }] },
  })
  // The prompt result carries the assistant message; pull text out defensively across shapes.
  return extractText(res)
}

function extractText(res: any): string {
  // Normalize a streaming/array response to its last message before reading parts, so an array
  // shape isn't mistaken for "no output" (which would mis-mark a successful job NOT RUN).
  const root = Array.isArray(res) ? res[res.length - 1] : res
  const parts = root?.parts ?? root?.data?.parts ?? root?.message?.parts ?? []
  const text = parts
    .filter((p: any) => p?.type === "text" && typeof p.text === "string")
    .map((p: any) => p.text)
    .join("\n")
    .trim()
  return text || (typeof root?.text === "string" ? root.text.trim() : "")
}

export interface Job { label: string; agent: string; prompt: string }
export interface JobResult { label: string; ok: boolean; text: string }

async function tryOne(ctx: PluginCtx, job: Job): Promise<JobResult> {
  try {
    const out = await withTimeout(runAgent(ctx, job.agent, job.prompt), STUCK_MS)
    if (out && typeof out === "object" && (out as any).__timeout) {
      return { label: job.label, ok: false, text: "" } // stuck — eligible for sequential retry
    }
    const text = String(out)
    return { label: job.label, ok: text.length > 0, text }
  } catch (e) {
    return { label: job.label, ok: false, text: `error: ${e instanceof Error ? e.message : String(e)}` }
  }
}

export async function fanOut(ctx: PluginCtx, jobs: Job[]): Promise<JobResult[]> {
  // Pass 1: concurrent.
  const first = await Promise.all(jobs.map((j) => tryOne(ctx, j)))
  const failedIdx = first.map((r, i) => (r.ok ? -1 : i)).filter((i) => i >= 0)
  if (failedIdx.length === 0) return first

  // Pass 2: sequential retry of the stuck/failed jobs (the #8528/#6573 mitigation).
  for (const i of failedIdx) {
    const retry = await tryOne(ctx, jobs[i])
    first[i] = retry.ok
      ? retry
      : {
          label: jobs[i].label,
          ok: false,
          text:
            `NOT RUN — child session for "${jobs[i].agent}" produced no output after a concurrent ` +
            `attempt and a sequential retry. This matches opencode child-session execution bugs ` +
            `(#8528/#6573); check your opencode version. ${retry.text}`.trim(),
        }
  }
  return first
}
