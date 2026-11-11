// craft-rust opencode plugin — one module for both OpenCode runtimes. Its default export carries both entries:
//   • `server(input)` — 1.x reads `{id, server}` (observed on opencode 1.19.5) and gets the 1.x hooks (host-v1.ts)
//   • `setup(ctx)`    — 2.x reads `{id, setup}` (observed on opencode 2.2.7, which ignores `server`) and gets the
//                       same tools (the audit and the triage refusing up front there: tools.ts, onV2) and hook through ctx.tool /
//                       ctx.session / ctx.event (host-v2.ts)
// CONTAINED:
//   • registers craft's workflow tools (tools.ts)
//   • and craft's hook at the moment of work (work-hook.ts): it only remembers subagent sessions, logs
//     compactions, and adds lines to a review request in a repo that declares its roles or work rules —
//     silent elsewhere, off with CRAFT_ROLE_HOOK=0 (realm @nick/craft, node #288)
//   • intercepts NO permission, tool call or model request
//   • talks only to the local opencode server; opens no ports, no outbound network, no telemetry; the hook
//     writes one line per firing to ~/.craft/hooks.jsonl
//   • the 5 review subagents stay hidden (their own frontmatter: hidden: true)
import type { PluginInput, PluginModule } from "@opencode-ai/plugin"
import { v1Hooks } from "./host-v1.ts"
import { v2Setup } from "./host-v2.ts"
import type { V2Context } from "./opencode-v2.js"
import { ENGINE_SESSIONS } from "./child-run.ts"
import { onV2, TOOLS } from "./tools.ts"
import { workHook } from "./work-hook.ts"

const craft: PluginModule & { id: string; setup(ctx: V2Context): Promise<() => Promise<void>> } = {
  id: "craft-rust",
  server: async (input: PluginInput) => v1Hooks(input, TOOLS, workHook(input.directory, ENGINE_SESSIONS)),
  setup: (ctx) => v2Setup(ctx, onV2(TOOLS), workHook(ctx.location.directory, ENGINE_SESSIONS)),
}

export default craft
