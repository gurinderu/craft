// The tools craft registers in OpenCode, once for both runtimes: host-v1.ts turns each into a `tool()`,
// host-v2.ts into a `ctx.tool` definition with a JSON Schema input.
import type { ToolSpec } from "./host.ts"
import { runRustAudit } from "./rust-audit.ts"
import { runTriageFindings } from "./triage-findings.ts"

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
]
