// The tools craft registers in OpenCode, once for both runtimes: host-v1.ts turns each into a `tool()`,
// host-v2.ts into a `ctx.tool` definition with a JSON Schema input.
import type { Host, ToolSpec } from "./host.ts"
import { ENGINE_SESSIONS } from "./orchestrator.ts"
import { runRustAudit } from "./rust-audit.ts"
import { runTriageFindings } from "./triage-findings.ts"

// The review driver lives in craft's lib/ (lib/opencode-review.mjs), loaded from the checkout the plugin is linked from
// when the tool runs, as the work hook loads its modules: a plugin copy without lib/ keeps its other tools.
async function runReview(host: Host, args: string): Promise<string> {
  const { reviewInOpenCode } = await import("../../../lib/opencode-review.mjs")
  return reviewInOpenCode(args, {
    directory: host.directory,
    // Its child sessions are the review's own loop: the work hook stays silent there (work-hook.ts).
    runChild: (req) => host.runChild({ ...req, onSession: (id) => ENGINE_SESSIONS.add(id) }),
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
    run: (host, args) => runReview(host, args["args"] ?? ""),
  },
]
