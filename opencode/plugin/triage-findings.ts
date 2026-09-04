// Mirrors workflows/triage-findings.js: gather → validate each finding against the code (parallel)
// → render one ordered fix plan + triage ledger. No edits. Delegates the per-finding code-check to
// the hidden rust-reviewer agent; the final plan is synthesized on the session's default model.
import type { PluginCtx } from "./index.ts"
import { fanOut, runAnswering, type Job } from "./orchestrator.ts"
import { buildTriageRecord, hasOutcomeLine, writeRecord } from "./run-record.mjs"
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
export function splitFindings(blob: string): { findings: string[]; dropped: number; skipped: number } {
  const raw = blob.split("\n")
  const items: string[] = []
  let skipped = 0
  let inFence = false
  let open = false // whether the last item is still accepting continuation lines
  for (const line of raw) {
    const l = line.trim()
    // A fenced block is code or sample output, not findings.
    if (/^(```|~~~)/.test(l)) { inFence = !inFence; continue }
    if (inFence) { if (l.length) skipped++; continue }
    // A blank line ends an item. This is what makes a PARAGRAPH one finding instead of one per line:
    // markdown wraps at column zero, so "indented means continuation" was true of code and false of
    // prose — and an ordinary multi-KB report then saturated the cap on paragraph fragments alone,
    // spending forty child sessions on half-sentences while real findings past the cap were dropped.
    if (!l.length) { open = false; continue }
    if (/^#{1,6}\s/.test(l)) { open = false; continue }
    // Furniture: a horizontal rule, a table's |---|---| rule, a lone bold heading.
    if (/^([-*_])\1{2,}$/.test(l.replace(/\s+/g, "")) || /^\|[\s|:-]*\|$/.test(l) || /^\*\*[^*]+\*\*$/.test(l)) {
      skipped++
      open = false
      continue
    }
    const starts = /^[-*+]\s+\S/.test(l) || /^\d+[.)]\s+\S/.test(l) || /^\|.*\|$/.test(l)
    if (starts) { items.push(l); open = true; continue }
    // Anything else continues the item above it — including a line at column zero, which is what a
    // wrapped bullet and a wrapped paragraph both look like. Only when no item is open does it start
    // one, so a paragraph becomes a single finding rather than one per line.
    if (open && items.length) { items[items.length - 1] += ` ${l}` } else { items.push(l); open = true }
  }
  const findings = items.slice(0, MAX_FINDINGS)
  return { findings, dropped: Math.max(0, items.length - MAX_FINDINGS), skipped }
}

export async function runTriageFindings(ctx: PluginCtx, args: { locator: string }): Promise<string> {
  const blob = gather(args.locator)
  const { findings, dropped, skipped } = splitFindings(blob)
  if (findings.length === 0) return "No findings parsed from the locator."
  // Said out loud, at the top of the plan. Dropping input silently is what turns "triaged" into a
  // claim about findings nobody looked at — a Critical one past the cap vanished with no trace in
  // the output OR the run record.
  const coverage = dropped
    ? `> ⚠️ **INCOMPLETE — ${dropped} finding(s) past the first ${MAX_FINDINGS} were NOT triaged.** This plan covers only what is listed below; scope the input down and re-run to cover the rest.\n`
    : ""
  const skippedNote = skipped ? `> ${skipped} line(s) inside code fences or table furniture were not treated as findings.\n` : ""

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
  const validated = await fanOut(ctx, jobs.map((j) => ({ ...j, answered: hasOutcomeLine })))
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
  // The planner is gated too, though more weakly: its prompt mandates no single machine-readable
  // line, so what is asked of it is that it produced the sections it was told to produce. Prose that
  // contains neither is a refusal, not a plan.
  const planned = await runAnswering(ctx, "", planPrompt, (t) => /triage ledger/i.test(t) || /fix plan/i.test(t))
    .catch(() => ({ ok: false, text: "" }))
  const plan = planned.ok ? planned.text : unplanned
  await writeRecord(ctx, buildTriageRecord({ results: validated }))
  // The warning LEADS. Placed at the end it is the last thing on a long page — and the case it
  // exists for is precisely the one that makes the page long.
  return `${coverage}${skippedNote}${plan}`
}
