// Mirrors workflows/triage-findings.js: gather → validate each finding against the code (parallel)
// → render one ordered fix plan + triage ledger. No edits. Delegates the per-finding code-check to
// the hidden rust-reviewer agent; the final plan is synthesized on the session's default model.
import type { PluginCtx } from "./index.ts"
import { fanOut, runAgent, type Job } from "./orchestrator.ts"
import { buildTriageRecord, writeRecord } from "./run-record.mjs"
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

const MAX_FINDINGS = 40

// Split a findings blob into individual items. What counts as a finding is a LINE THAT LOOKS LIKE
// ONE — a list item, or a line carrying a file:line reference — not merely a non-empty line. Taking
// every line meant prose, table rows and wrapped continuations each became a "finding" and each
// spawned a child session, while the real findings past the cap were dropped; the plan then
// presented itself as a complete triage of the input.
function splitFindings(blob: string): { findings: string[]; dropped: number; skipped: number } {
  const lines = blob.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !/^#{1,6}\s/.test(l))
  const looksLikeFinding = (l: string) =>
    /^[-*+]\s+\S/.test(l) || /^\d+[.)]\s+\S/.test(l) || /\S+\.[A-Za-z0-9]+:\d+/.test(l) || /^\|.*\|$/.test(l)
  const candidates = lines.filter(looksLikeFinding)
  // Prose-only input is still a finding — a user pasting one sentence means that sentence. Falling
  // back to every line is right THERE and wrong for a report, so the fallback is scoped to the case
  // where nothing structured was found at all.
  const chosen = candidates.length ? candidates : lines
  return { findings: chosen.slice(0, MAX_FINDINGS), dropped: Math.max(0, chosen.length - MAX_FINDINGS), skipped: lines.length - chosen.length }
}

export async function runTriageFindings(ctx: PluginCtx, args: { locator: string }): Promise<string> {
  const blob = gather(args.locator)
  const { findings, dropped, skipped } = splitFindings(blob)
  if (findings.length === 0) return "No findings parsed from the locator."
  // Said out loud, at the top of the plan. Dropping input silently is what turns "triaged" into a
  // claim about findings nobody looked at — a Critical one past the cap vanished with no trace in
  // the output OR the run record.
  const coverage = dropped
    ? `\n\n> ⚠️ **INCOMPLETE — ${dropped} finding(s) past the first ${MAX_FINDINGS} were NOT triaged.** This plan covers only what is listed below; scope the input down and re-run to cover the rest.`
    : ""
  const skippedNote = skipped ? `\n> ${skipped} line(s) in the input did not look like findings and were not triaged.` : ""

  const jobs: Job[] = findings.map((f, i) => ({
    label: `f${i + 1}`,
    agent: "rust-reviewer",
    prompt: `Validate this single review finding against the actual code. Do NOT fix anything.
Finding: ${f}

Decide exactly one outcome: accept | reject | defer | needs-decision | conflict, with one or two
sentences of reasoning grounded in the code (cite file:line if you can). Output, with the OUTCOME
line LAST and nothing after it — it is machine-read, like the VERDICT line elsewhere in craft:
REASON: <grounded reasoning>
OUTCOME: <exactly one of the five, lowercase>`,
  }))

  // Same discriminator as the audit: these prompts demand an OUTCOME line, so carrying one is what
  // it means to have answered. Without it a refusal counted as a validation.
  const validated = await fanOut(ctx, jobs.map((j) => ({ ...j, expect: /^\s*OUTCOME:\s*(accept|reject|defer|needs-decision|conflict)\b/mi })))
  const ledger = validated
    .map((r, i) => `- **${r.label}** (${r.ok ? "validated" : "INCOMPLETE (not run)"}): ${findings[i]}\n  ${r.text.replace(/\n/g, "\n  ")}`)
    .join("\n")

  const planPrompt = `You are turning validated review findings into ONE ordered fix plan (writing-plans style) plus a triage ledger. Do not edit code.

Below is each finding with its validation outcome. Build:
1. A **triage ledger** table: finding · outcome (accept/reject/defer/needs-decision/conflict) · reason.
2. An **ordered fix plan** containing ONLY the \`accept\`ed findings, sequenced so prerequisites come first, each as a short task with file:line and the fix direction.
3. A short **open questions** list for any \`needs-decision\` / \`conflict\` items.

VALIDATED FINDINGS:
${ledger}`

  // A dead planner used to hand back the raw ledger, which reads like a finished triage. It is not
  // one: nothing was ordered, and the open questions were never separated out.
  const unplanned = `## ⚠️ INCOMPLETE (not run) — the fix plan was not produced\n\nThe planning step returned nothing, so what follows is the raw validation ledger rather than an ordered plan. Nothing here is a decision about what to fix first.\n\n${ledger}`
  const plan = (await runAgent(ctx, "", planPrompt).catch(() => "")) || unplanned
  await writeRecord(ctx, buildTriageRecord({ results: validated }))
  return `${plan}${coverage}${skippedNote}`
}
