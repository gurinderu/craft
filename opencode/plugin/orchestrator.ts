// Deterministic child-session fan-out with a sequential fallback for opencode's known
// child-session execution bugs (anomalyco/opencode #8528, sst/opencode #6573): if a child
// session is created but never executes within STUCK_MS, retry the failed jobs one at a time;
// if a job still yields nothing, surface a clear, actionable error rather than hang.
//
// Signatures (client.session.create / client.session.prompt) follow the opencode SDK docs;
// `tsc` will flag any mismatch against the installed @opencode-ai/sdk types — adjust there.
import type { PluginCtx } from "./index.ts"

// A dimension that runs `cargo clippy --all-targets` and `cargo test` on a real workspace takes
// minutes, not seconds. The old 90s ceiling therefore fired on essentially every Rust repository
// this plugin exists for, and the timeout was then reported as an opencode child-session bug — so
// the user went looking for a version problem instead of a deadline. A deadline exists to stop a
// hang, so it belongs far past the slowest legitimate run; jobs that know they are cheap can say so.
const STUCK_MS = 20 * 60_000

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | { __timeout: true }> {
  // The timer is CLEARED when the race settles. Left pending it kept one live timer per job for the
  // whole deadline — invisible at 90 seconds in a long-lived process, and immediately visible once
  // the deadline became twenty minutes: any host that waits for the event loop to drain simply
  // stops. `unref` alone would hide it rather than fix it.
  let timer: ReturnType<typeof setTimeout> | undefined
  const ticking = new Promise<{ __timeout: true }>((r) => {
    timer = setTimeout(() => r({ __timeout: true }), ms)
  })
  return Promise.race([p, ticking]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
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

// `answered` is what makes a job's answer an ANSWER rather than merely output. Without it liveness was
// inferred from `text.length > 0`, so a refusal, a tool-permission error, or "I'll start by looking
// at the repo" counted as success — and that text then reached the verdict parser, which falls
// through to APPROVE. A dimension whose session errored out therefore reported Approve. Callers that
// require a machine-readable line pass the PARSER'S OWN predicate here — not a second regex, which
// drifted from the parser the moment it existed. A job with no `answered` keeps the old non-empty
// rule, which is honest for jobs whose output is prose by design.
export interface Job {
  label: string
  agent: string
  prompt: string
  answered?: (text: string) => boolean
  timeoutMs?: number
  // What the job asked for, in the reader's words. Hard-coding "verdict line" sent the forty triage
  // jobs looking for a line their prompt never mentioned — the same wrong-cause reporting this file
  // fixed for timeout-versus-silence.
  requires?: string
}

// One call, held to the same standard as a fan-out job. The consolidation step used to bypass all of
// it — no predicate, no deadline — which left the audit's most authoritative text as the single path
// exempt from the rule the rest of the branch is about: a refusal from the synthesising session was
// non-empty, so it was treated as the report AND filed as a verdict, and parseVerdict falls through
// to Approve. A hung synthesis also hung the whole run, since only dimensions had a deadline.
export async function runAnswering(
  ctx: PluginCtx,
  agent: string,
  prompt: string,
  answered: (text: string) => boolean,
  timeoutMs = STUCK_MS,
): Promise<{ ok: boolean; text: string }> {
  const r = await tryOne(ctx, { label: agent || "default", agent, prompt, answered, timeoutMs })
  return { ok: r.ok, text: r.text }
}
export interface JobResult { label: string; ok: boolean; text: string }

// Why the job failed, in the words a reader can act on. Conflating these was half the defect: a
// deadline reported as "no output" sent people to look for an opencode bug.
type Failure = "timeout" | "empty" | "unanswered" | "error" | "budget"

async function tryOne(ctx: PluginCtx, job: Job): Promise<JobResult & { why?: Failure }> {
  try {
    const out = await withTimeout(runAgent(ctx, job.agent, job.prompt), job.timeoutMs ?? STUCK_MS)
    if (out && typeof out === "object" && (out as any).__timeout) {
      return { label: job.label, ok: false, text: "", why: "timeout" }
    }
    const text = String(out)
    if (!text.length) return { label: job.label, ok: false, text, why: "empty" }
    // Output that does not carry what the job asked for is not a result. Keeping the text matters:
    // a refusal or an error message is the most useful thing to show the reader about why.
    if (job.answered && !job.answered(text)) return { label: job.label, ok: false, text, why: "unanswered" }
    return { label: job.label, ok: true, text }
  } catch (e) {
    return { label: job.label, ok: false, text: `error: ${e instanceof Error ? e.message : String(e)}`, why: "error" }
  }
}

function notRunNote(job: Job, why: Failure | undefined, detail: string): string {
  const ms = job.timeoutMs ?? STUCK_MS
  // Seconds below a minute: `Math.round` turned every short deadline into "within 0 minutes", which
  // is what a test drove without noticing, because it asserted only the prefix.
  const span = ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : ms >= 1000 ? `${Math.round(ms / 1000)} seconds` : `${ms} ms`
  const cause =
    why === "budget"
      ? `the retry budget for this run was already spent on earlier jobs, so it was not attempted a second time`
      : why === "timeout"
        ? `it produced no result within ${span}. If this dimension runs a build or a test suite, it may simply need longer than that deadline`
        : why === "unanswered"
          ? `it answered, but without the ${job.requires ?? "machine-readable line"} the prompt requires — so nothing it said can be read as a result. Its output is kept below`
          : why === "error"
            ? `the child session errored on its last attempt`
            : `the child session produced no output after a concurrent attempt and a sequential retry. This matches opencode child-session execution bugs (#8528/#6573); check your opencode version`
  return `INCOMPLETE (not run) — the child session for "${job.agent || "the default model"}" did not deliver a result: ${cause}. ${detail}`.trim()
}

// The SEQUENTIAL pass needs a budget of its own, because its cost is per job rather than shared.
// Raising the per-job deadline to twenty minutes made that arithmetic unlivable: ten audit
// dimensions retried one after another is nearly four hours with nothing on screen, and forty
// triage findings is over half a day. A deadline that turns a hang into a longer hang has not
// helped anyone. So the retries share one wall-clock budget: whoever is left when it runs out is
// reported not-run without being attempted, which is the truthful thing to say about them.
const RETRY_BUDGET_MS = 30 * 60_000

// The budget is a PARAMETER, not only a constant, because a test that cannot shrink it cannot reach
// the clipping branch at all: with thirty minutes remaining, `Math.min(job.timeoutMs, left)` is
// always the job's own value, so the assertion held whether or not the clipping existed.
export async function fanOut(ctx: PluginCtx, jobs: Job[], retryBudgetMs = RETRY_BUDGET_MS): Promise<JobResult[]> {
  // Pass 1: concurrent.
  const first = await Promise.all(jobs.map((j) => tryOne(ctx, j)))
  const failedIdx = first.map((r, i) => (r.ok ? -1 : i)).filter((i) => i >= 0)
  if (failedIdx.length === 0) return first

  // Pass 2: sequential retry of the stuck/failed jobs (the #8528/#6573 mitigation).
  const deadline = Date.now() + retryBudgetMs
  for (const i of failedIdx) {
    const left = deadline - Date.now()
    if (left <= 0) {
      first[i] = { label: jobs[i].label, ok: false, text: notRunNote(jobs[i], "budget", first[i].text) }
      continue
    }
    // The clipped deadline is what the retry actually ran under, so it is what the note must
    // describe. Reading the unclipped one told the reader "no result within 20 minutes" about a job
    // that was given ninety seconds — a false span pointing at a deadline that never fired.
    const effective = { ...jobs[i], timeoutMs: Math.min(jobs[i].timeoutMs ?? STUCK_MS, left) }
    const retry = await tryOne(ctx, effective)
    first[i] = retry.ok ? retry : { label: jobs[i].label, ok: false, text: notRunNote(effective, retry.why, retry.text) }
  }
  return first
}
