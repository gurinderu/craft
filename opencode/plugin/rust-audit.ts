// Mirrors workflows/rust-audit.js: scout → fan out reviewers (Miri only if unsafe) → synthesize.
import type { PluginCtx } from "./index.ts"
import { fanOut, runAgent, type Job } from "./orchestrator.ts"

async function sh(ctx: PluginCtx, cmd: string): Promise<string> {
  try {
    const r = await ctx.$`bash -lc ${cmd}`.quiet()
    return (r.stdout?.toString?.() ?? String(r.stdout ?? "")).trim()
  } catch {
    return ""
  }
}

async function scout(ctx: PluginCtx, base?: string): Promise<{ baseRef: string; hasUnsafe: boolean }> {
  let baseRef = base ?? ""
  if (!baseRef) {
    for (const c of [
      "git merge-base HEAD origin/main 2>/dev/null",
      "git merge-base HEAD main 2>/dev/null",
      "git rev-parse HEAD~1 2>/dev/null",
    ]) {
      baseRef = await sh(ctx, c)
      if (baseRef) break
    }
  }
  const unsafeHits = await sh(ctx, `grep -rnE "\\bunsafe\\b" --include=*.rs . | head -n1`)
  return { baseRef, hasUnsafe: unsafeHits.length > 0 }
}

export async function runRustAudit(ctx: PluginCtx, args: { base?: string }): Promise<string> {
  const { baseRef, hasUnsafe } = await scout(ctx, args.base)
  const diffNote = baseRef
    ? `Diff base: \`${baseRef}\`.`
    : "There is no clean base ref — review uncommitted changes, or the most recent commit if the tree is clean."

  const jobs: Job[] = [
    {
      label: "review",
      agent: "rust-reviewer",
      prompt: `Review the Rust diff for mergeability using the rust-review rubric. ${diffNote} Report every finding with severity and confidence (coverage, not filtering), then your Approve/Warning/Block verdict.`,
    },
    {
      label: "architecture",
      agent: "rust-architecture-reviewer",
      prompt: `Audit the architecture of this whole Rust project: build the crate/module dependency graph and judge it in both directions (layer leaks/god modules vs ghost abstractions/over-layering). Return your Healthy/Concerns/At-risk rating and findings.`,
    },
    {
      label: "security",
      agent: "rust-security-scanner",
      prompt: `Run the Rust security toolchain (cargo-audit, cargo-deny, cargo-geiger, semgrep — whatever is installed) and consolidate into a severity-ranked verdict and findings. Note any absent tools.`,
    },
  ]
  if (hasUnsafe) {
    jobs.push({
      label: "miri",
      agent: "rust-miri",
      prompt: `This workspace contains unsafe code. Run its tests under Miri and report any undefined behavior against the rust-unsafe rubric. Return a Clean / UB-found verdict and findings.`,
    })
  }

  const results = await fanOut(ctx, jobs)

  // Synthesize through a fresh child session (no agent → the session's default model/persona).
  const blob = results.map((r) => `### ${r.label} (${r.ok ? "ran" : "NOT RUN"})\n\n${r.text}`).join("\n\n")
  const synthPrompt = `You are consolidating a Rust audit. Below are the per-dimension results. Produce ONE markdown report — do not invent findings, only merge what is given:

1. An **overall verdict** line — the worst case across dimensions. If any dimension is "NOT RUN", mark the audit INCOMPLETE.
2. A **dimension → verdict** table; give any NOT RUN dimension the verdict \`NOT RUN\` (do not treat absence as a pass).
3. **Findings by severity** (Critical first), each tagged with its dimension and location + a one-line fix direction.
4. A short **"Fix first"** list of the highest-leverage items.

RESULTS:
${blob}`

  return await runAgent(ctx, "", synthPrompt).catch(() => blob) || blob
}
