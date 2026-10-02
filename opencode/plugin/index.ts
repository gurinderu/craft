// craft-rust opencode plugin — CONTAINED:
//   • registers ONLY the two craft workflow tools (via the `tool` hook)
//   • installs NONE of: event / chat.message / chat.params / tool.execute.* / permission.ask
//   • talks only to the injected local `client`; opens no ports, no outbound network, no telemetry
//   • the 4 review subagents stay hidden (their own frontmatter: hidden: true)
//
// The plugin's own shape — the `Plugin` signature, `tool({ description, args, execute })` and
// `tool.schema` — is type-checked by `tsc` against the installed @opencode-ai/plugin. The session
// calls are NOT: PluginCtx.client (and `$`) is `any` and nothing here imports @opencode-ai/sdk, so
// `tsc` passes whatever the SDK's real shapes are; a mismatch there shows only at runtime, in opencode.
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
