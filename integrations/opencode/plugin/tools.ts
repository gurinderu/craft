// The tools craft registers in OpenCode, once for both runtimes: host-v1.ts turns each into a `tool()`,
// host-v2.ts into a `ctx.tool` definition with a JSON Schema input.
import type { Host, ToolAnswer, ToolCall, ToolSpec } from "./host.ts"
import { runRustAudit } from "./rust-audit.ts"
import { runTriageFindings } from "./triage-findings.ts"

// The host as a workflow sees it from inside one tool call: every child session it opens nests under the calling
// session (OpenCode's parentID, observed on 1.19.5 and 2.2.7); a call with no session leaves them top-level.
export function nestedUnder(host: Host, parent: string | undefined): Host {
  if (!parent) return host
  return { ...host, runChild: (req) => host.runChild({ ...req, parentID: parent }) }
}

// The review is the craft binary's own driver with its opencode backend, run through the plugin's bin/craft
// (lib/craft-review-run.mjs; realm @nick/craft, nodes #499, #503): each task an `opencode run` on craft's read-only
// agents, every tier on the calling session's model unless the flags name `--models`. lib/ is loaded from the
// checkout the plugin is linked from when the tool runs, as the work hook loads its modules: a plugin copy without
// lib/ keeps its other tools.
const hasModels = (words: string[]) => words.some((w) => w === "--models" || w.startsWith("--models="))

async function runReview(host: Host, args: string, call: ToolCall): Promise<ToolAnswer> {
  const review = await import("../../../lib/craft-review-run.mjs")
  const words = review.flagWords(args)
  const model = hasModels(words) || !call.sessionID ? undefined : await host.callerModel(call.sessionID).catch(() => undefined)
  const outcome = await review.runReview({
    backend: "opencode",
    args: model ? [...words, "--models", `${model.providerID}/${model.modelID}`] : words,
    cwd: host.directory,
    ...(call.signal ? { signal: call.signal } : {}),
    onProgress: (p) => call.progress?.(review.progressLine(p)),
  })
  return { title: `craft review: ${review.summaryOf(outcome).verdict}`, output: review.answerText(outcome) }
}

// What the audit and the triage answer on OpenCode 2.x, before any child session: no 2.x child session was seen
// answering. Built here, without lib/, so a plugin copy without it still answers. The review is not refused: it runs
// each task as its own `opencode run` (realm @nick/craft, nodes #499, #502), seen answering on 2.2.7.
export function refusalOnV2(name: string): string {
  return `⚠️ INCOMPLETE — craft's \`${name}\` does not yet work in OpenCode 2.x: its child sessions never answered in testing (craft 0.50.0, OpenCode 2.2.7). A route through \`opencode run\` is in progress; until it ships, use OpenCode 1.x, Claude Code, Codex or pi. Nothing ran.`
}

/**
 * The tools as the 2.x entry (`setup`) registers them: the workflows that run child sessions refuse up front and say so
 * in their description; all stay registered, to answer a call with why. The review runs as it is.
 */
export const onV2 = (tools: readonly ToolSpec[]): ToolSpec[] =>
  tools.map((spec) =>
    spec.name === "review"
      ? spec
      : {
          ...spec,
          description: `Not available on OpenCode 2.x yet: craft's \`${spec.name}\` answers INCOMPLETE and runs nothing (use OpenCode 1.x, Claude Code, Codex or pi).`,
          run: () => Promise.resolve(refusalOnV2(spec.name)),
        },
  )

export const TOOLS: readonly ToolSpec[] = [
  {
    name: "rust-audit",
    description:
      "Full Rust crate audit: fan out the craft review agents (reviewer, architecture, security, and Miri if unsafe is present) and synthesize one severity-ranked report. Optional arg `base` fixes the diff base ref.",
    args: { base: { optional: true } },
    run: (host, args, call) => runRustAudit(nestedUnder(host, call.sessionID), args["base"] === undefined ? {} : { base: args["base"] }),
  },
  {
    name: "triage-findings",
    description:
      "Validate review findings against the code and render one ordered fix plan + triage ledger (no edits). Arg `locator` points at the findings source (a report path, PR ref, or pasted findings).",
    args: { locator: { optional: false } },
    run: (host, args, call) => runTriageFindings(nestedUnder(host, call.sessionID), { locator: args["locator"] ?? "" }),
  },
  {
    name: "review",
    description:
      "craft's review of the current change by the `craft` binary (`craft review run --backend opencode`): the mechanical gate, review lenses per language profile, verification, one report and the `## Verdict` block; each task runs as its own `opencode run` on craft's read-only agents, on this session's model. It runs long. Arg `args` takes the review's flags as one string (for example `--base main`, `--depth light`, `--pr 123 --comment`, `--run <dir>` to resume, `--models <provider/model>`), or none.",
    args: { args: { optional: true } },
    run: (host, args, call) => runReview(host, args["args"] ?? "", call),
  },
]
