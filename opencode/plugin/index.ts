// craft-rust opencode plugin — CONTAINED:
//   • registers ONLY the two craft workflow tools (via the `tool` hook)
//   • installs NONE of: event / chat.message / chat.params / tool.execute.* / permission.ask
//   • talks only to the injected local `client`; opens no ports, no outbound network, no telemetry
//   • the 4 review subagents stay hidden (their own frontmatter: hidden: true)
//
// Signatures follow the opencode docs; if the installed @opencode-ai/* types differ, `tsc` will
// flag it — adjust to the installed types (the shapes here are the documented ones).
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { runRustAudit } from "./rust-audit.ts"
import { runTriageFindings } from "./triage-findings.ts"

// The subset of the plugin input that our orchestration needs.
export interface PluginCtx {
  client: any        // @opencode-ai/sdk client (session.create / session.prompt)
  $: any             // Bun shell ($`...`)
  directory: string
  worktree: string
}

const CraftRustPlugin: Plugin = async ({ client, $, directory, worktree }) => {
  const ctx: PluginCtx = { client, $, directory, worktree }
  return {
    // ONLY this hook. No global hooks → inert on every unrelated session.
    tool: {
      "rust-audit": tool({
        description:
          "Full Rust crate audit: fan out the craft review agents (reviewer, architecture, security, and Miri if unsafe is present) and synthesize one severity-ranked report. Optional arg `base` fixes the diff base ref.",
        args: { base: tool.schema.string().optional() },
        async execute(args: { base?: string }) {
          return await runRustAudit(ctx, args)
        },
      }),
      "triage-findings": tool({
        description:
          "Validate review findings against the code and render one ordered fix plan + triage ledger (no edits). Arg `locator` points at the findings source (a report path, PR ref, or pasted findings).",
        args: { locator: tool.schema.string() },
        async execute(args: { locator: string }) {
          return await runTriageFindings(ctx, args)
        },
      }),
    },
  }
}

export default CraftRustPlugin
