// The tools craft registers in OpenCode, once for both runtimes: host-v1.ts turns each into a `tool()`,
// host-v2.ts into a `ctx.tool` definition with a JSON Schema input.
import type { ChildRequest, Host, ModelRef, ToolCall, ToolSpec } from "./host.ts"
import { ENGINE_SESSIONS } from "./orchestrator.ts"
import { runRustAudit } from "./rust-audit.ts"
import { runTriageFindings } from "./triage-findings.ts"

// The review driver lives in craft's lib/ (lib/opencode-review.mjs), loaded from the checkout the plugin is linked from
// when the tool runs, as the work hook loads its modules: a plugin copy without lib/ keeps its other tools.
// A review task's child session: nested under the calling session, on that session's model unless the review's table
// mapped the task's tier, and one of the review's own loop, so the work hook stays silent there (work-hook.ts).
export function reviewChild(host: Host, parent: string | undefined, callerModel: ModelRef | undefined) {
  return (req: ChildRequest): Promise<string> => {
    const model = req.model ?? callerModel
    return host.runChild({ ...req, ...(model ? { model } : {}), ...(parent ? { parentID: parent } : {}), onSession: (id) => ENGINE_SESSIONS.add(id) })
  }
}

async function runReview(host: Host, args: string, call: ToolCall): Promise<string> {
  const { reviewInOpenCode } = await import("../../../lib/opencode-review.mjs")
  const parent = call.sessionID
  const callerModel = parent ? await host.callerModel(parent).catch(() => undefined) : undefined
  return reviewInOpenCode(args, {
    directory: host.directory,
    runChild: reviewChild(host, parent, callerModel),
    log: (line) => console.error(`craft review: ${line}`),
  })
}

export const TOOLS: readonly ToolSpec[] = [
  {
    name: "rust-audit",
    description:
      "Full Rust crate audit: fan out the craft review agents (reviewer, architecture, security, and Miri if unsafe is present) and synthesize one severity-ranked report. Optional arg `base` fixes the diff base ref.",
    args: { base: { optional: true } },
    run: (host, args) => runRustAudit(host, args["base"] === undefined ? {} : { base: args["base"] }),
  },
  {
    name: "triage-findings",
    description:
      "Validate review findings against the code and render one ordered fix plan + triage ledger (no edits). Arg `locator` points at the findings source (a report path, PR ref, or pasted findings).",
    args: { locator: { optional: false } },
    run: (host, args) => runTriageFindings(host, { locator: args["locator"] ?? "" }),
  },
  {
    name: "review",
    description:
      "craft's review of the current change, driven by the `craft` binary step by step: it plans the lenses, each task runs as a child session, and it answers with the `## Verdict` block. Arg `args` takes the review's own `key=value` words (for example `base=main`, `pr=123`, `run=<dir>` to resume, `opencodeModels=<provider/model>`), or none.",
    args: { args: { optional: true } },
    run: (host, args, call) => runReview(host, args["args"] ?? "", call),
  },
]
