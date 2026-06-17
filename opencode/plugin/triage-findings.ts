// Mirrors workflows/triage-findings.js: gather → validate each finding against the code (parallel)
// → render one ordered fix plan + triage ledger. No edits. Delegates the per-finding code-check to
// the hidden rust-reviewer agent; the final plan is synthesized on the session's default model.
import type { PluginCtx } from "./index.ts"
import { fanOut, runAgent, type Job } from "./orchestrator.ts"
import { existsSync, readFileSync } from "node:fs"

// Read the locator as a file when it points at one; otherwise treat it as literal findings text.
// Use FS APIs (not a shell) so the locator can never be interpreted as a command — no injection.
function gather(locator: string): string {
  try {
    return existsSync(locator) ? readFileSync(locator, "utf8") : locator
  } catch {
    return locator
  }
}

// Split a findings blob into individual items (one per non-empty line that looks like a finding).
function splitFindings(blob: string): string[] {
  return blob
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^#{1,6}\s/.test(l)) // drop markdown headings
    .slice(0, 40) // cap; a triage of >40 raw lines should be scoped down first
}

export async function runTriageFindings(ctx: PluginCtx, args: { locator: string }): Promise<string> {
  const blob = gather(args.locator)
  const findings = splitFindings(blob)
  if (findings.length === 0) return "No findings parsed from the locator."

  const jobs: Job[] = findings.map((f, i) => ({
    label: `f${i + 1}`,
    agent: "rust-reviewer",
    prompt: `Validate this single review finding against the actual code. Do NOT fix anything.
Finding: ${f}

Decide exactly one outcome: accept | reject | defer | needs-decision | conflict, with one or two
sentences of reasoning grounded in the code (cite file:line if you can). Output:
OUTCOME: <one of the five>
REASON: <grounded reasoning>`,
  }))

  const validated = await fanOut(ctx, jobs)
  const ledger = validated
    .map((r, i) => `- **${r.label}** (${r.ok ? "validated" : "NOT RUN"}): ${findings[i]}\n  ${r.text.replace(/\n/g, "\n  ")}`)
    .join("\n")

  const planPrompt = `You are turning validated review findings into ONE ordered fix plan (writing-plans style) plus a triage ledger. Do not edit code.

Below is each finding with its validation outcome. Build:
1. A **triage ledger** table: finding · outcome (accept/reject/defer/needs-decision/conflict) · reason.
2. An **ordered fix plan** containing ONLY the \`accept\`ed findings, sequenced so prerequisites come first, each as a short task with file:line and the fix direction.
3. A short **open questions** list for any \`needs-decision\` / \`conflict\` items.

VALIDATED FINDINGS:
${ledger}`

  return (await runAgent(ctx, "", planPrompt).catch(() => ledger)) || ledger
}
