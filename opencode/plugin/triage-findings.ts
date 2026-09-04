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
  const pending: string[] = [] // lines held inside a fence that may turn out never to close
  for (const line of raw) {
    const l = line.trim()
    // A fence DELIMITER is a line that opens or closes a block — not any line that happens to start
    // with backticks. `\`\`\`cargo test\`\`\` fails on main` opens and closes an inline span on one
    // line; toggling on it swallowed every finding after it, silently, because `dropped` stayed 0 so
    // the loud "N were NOT triaged" banner never fired. That is a loss path this file INVENTED: on
    // the previous behaviour a fence could not lose a finding, and the test at the top of the test
    // file says a wrongly-dropped line is the expensive error. The property is "an opener has a
    // partner", not "the line starts with a fence".
    const fence = l.match(/^(`{3,}|~{3,})/)
    if (fence && !l.slice(fence[0].length).includes(fence[1][0].repeat(3))) {
      inFence = !inFence
      if (!inFence) pending.length = 0 // it closed: what it held really was code
      continue
    }
    if (inFence) { if (l.length) { skipped++; pending.push(l) } continue }
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
  // An unterminated fence means the input was truncated or the marker was decorative. Swallowing the
  // remainder would lose findings on a guess; re-reading it as content costs at worst some noise,
  // and noise is visible where a missing Critical is not.
  if (inFence && pending.length) {
    for (const l of pending) items.push(l)
    skipped -= pending.length
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
  const validated = await fanOut(ctx, jobs.map((j) => ({ ...j, answered: hasOutcomeLine, requires: "OUTCOME: line" })))
  const ledger = validated
    .map((r, i) => `- **${r.label}** (${r.ok ? "validated" : "INCOMPLETE (not run)"}): ${findings[i]}\n  ${r.text.replace(/\n/g, "\n  ")}`)
    .join("\n")

  const planPrompt = `You are turning validated review findings into ONE ordered fix plan (writing-plans style) plus a triage ledger. Do not edit code.

Below is each finding with its validation outcome. Build:
1. A **triage ledger** table: finding · outcome (accept/reject/defer/needs-decision/conflict) · reason.
2. An **ordered fix plan** containing ONLY the \`accept\`ed findings, sequenced so prerequisites come first, each as a short task with file:line and the fix direction.
3. A short **open questions** list for any \`needs-decision\` / \`conflict\` items.

FINALLY, after everything else, end with ONE line on its own, exactly: \`PLAN: READY\` — nothing after
it. It is machine-read: it is how the caller tells a finished plan from a preamble or a refusal.

VALIDATED FINDINGS:
${ledger}`

  // A dead planner used to hand back the raw ledger, which reads like a finished triage. It is not
  // one: nothing was ordered, and the open questions were never separated out.
  const unplanned = `## ⚠️ INCOMPLETE (not run) — the fix plan was not produced\n\nThe planning step returned nothing, so what follows is the raw validation ledger rather than an ordered plan. Nothing here is a decision about what to fix first.\n\n${ledger}`
  // Gated on a TERMINAL MARKER the prompt mandates, not on keywords the prompt itself supplies. The
  // first attempt asked for "triage ledger" or "fix plan" — both of which appear in the instructions
  // in bold, so "I cannot build the triage ledger from these results" passed as a plan. A phrase the
  // prompt hands the model tests nothing; a line the model must choose to emit tests whether it got
  // to the end.
  const planned = await runAnswering(ctx, "", planPrompt, (t) => /^\s*[*_`>|-]*\s*PLAN:\s*READY\b/mi.test(t))
    .catch(() => ({ ok: false, text: "" }))
  const plan = planned.ok ? planned.text : unplanned
  // The record carries what the reader was told: a plan that never came, and findings that were
  // never triaged. The audit's record gained exactly this a commit ago; leaving the sibling without
  // it is how "no trace in the output OR the run record" stayed half true.
  await writeRecord(ctx, buildTriageRecord({ results: validated, planned: planned.ok, untriaged: dropped }))
  // The warning LEADS. Placed at the end it is the last thing on a long page — and the case it
  // exists for is precisely the one that makes the page long.
  return `${coverage}${skippedNote}${plan}`
}
