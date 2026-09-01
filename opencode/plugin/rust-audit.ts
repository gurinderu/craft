// Mirrors workflows/rust-audit.js (slim port): scout → fan out the agent dimensions (Miri only if
// unsafe) plus the whole-project tool dimensions (crate-decomposition, semver, build-matrix, deps,
// unused-crates, tests-cov, on the default session model) → synthesize. The Claude-Code-only
// elastic rust-review engine has no opencode equivalent, so the "review" dimension is a single-pass
// rust-reviewer (no per-crate / inter-crate-contract fan-out); see opencode/README.md parity caveats.
import type { PluginCtx } from "./index.ts"
import { fanOut, runAgent, type Job } from "./orchestrator.ts"
import { buildAuditRecord, writeRecord } from "./run-record.mjs"

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
  // sh() returns "" on both "no matches" and "shell/command failed". Append a marker that only
  // prints if the shell actually ran, so we can mirror workflows/rust-audit.js's `?? true`
  // fail-safe: when unsafe-detection does not resolve, run Miri anyway.
  const probe = await sh(ctx, `grep -rlE "\\bunsafe\\b" --include='*.rs' . 2>/dev/null | head -n1; echo "__scout_ok__"`)
  const ranOk = probe.includes("__scout_ok__")
  const hasMatch = probe.replace("__scout_ok__", "").trim().length > 0
  return { baseRef, hasUnsafe: hasMatch || !ranOk }
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
      prompt: `Audit the architecture of this whole Rust project: build the crate/module dependency graph and judge it in both directions (layer leaks/god modules vs ghost abstractions/over-layering). Return your Healthy/Concerns/At-risk rating and findings. If the graph could not be built at all — no manifest is readable and \`cargo metadata\` does not run — nothing was judged: return verdict "INCOMPLETE (not run)" naming what was missing, NOT Healthy.`,
    },
    {
      label: "security",
      agent: "rust-security-scanner",
      prompt: `Run the Rust security toolchain (cargo-audit, cargo-deny, cargo-geiger, semgrep — whatever is installed) and consolidate into a severity-ranked verdict and findings. Note any absent tools. If NONE of the tools is installed, so nothing was actually scanned, return verdict "INCOMPLETE (not run)" and name the missing tools — a scan that ran nothing is not an Approve.`,
    },
  ]
  if (hasUnsafe) {
    jobs.push({
      label: "miri",
      agent: "rust-miri",
      prompt: `This workspace contains unsafe code. Run its tests under Miri and report any undefined behavior against the rust-unsafe rubric. Return a Clean / UB-found verdict, or "INCOMPLETE (not run)" if the nightly toolchain or miri itself is unavailable so nothing was executed under Miri — an unrun Miri is NOT Clean. Return findings.`,
    })
  }

  // Whole-project tool dimensions — no dedicated agent (run on the default session model). Each runs
  // its tools, interprets, and degrades gracefully: a missing tool is an intentional skip, never a
  // failure — but a skip reports `INCOMPLETE (not run)`, not Approve. Approve stays reserved for
  // "the tool ran and found nothing"; a reader of the dimension table must be able to tell those
  // two apart.
  jobs.push(
    {
      label: "crate-decomposition",
      agent: "",
      prompt: `Judge this Rust workspace's crate boundaries: recommend where code should be EXTRACTED into its own crate, or where an over-split crate should be MERGED back (build on \`cargo metadata\`). For each recommendation give the DRIVER, the BOUNDARY, and the HOW. Recommend only — do not move code. Load the rust-ecosystem skill (crate-extraction). Return a Healthy/Concerns/At-risk verdict and findings.`,
    },
    {
      label: "semver",
      agent: "",
      prompt: `Check public-API semver compatibility across PUBLISHED crates: run \`cargo semver-checks check-release\` if installed. If cargo-semver-checks is absent, say so and return verdict "INCOMPLETE (not run)" with a one-line note naming what was missing — do NOT fail, and do NOT return Approve: nothing was checked. If the tool IS available but there is no published library crate to check, that is a real, complete answer — return "Approve" with a note that the workspace publishes no library. Load the rust-ecosystem skill. Report breaking changes vs the published baseline as findings.`,
    },
    {
      label: "build-matrix",
      agent: "",
      prompt: `Check the build across feature combinations and the MSRV. If \`cargo-hack\` is installed: \`cargo hack check --feature-powerset --no-dev-deps\`, plus \`cargo check --no-default-features\` and \`cargo check --all-features\`. For MSRV read \`rust-version\` from Cargo.toml and run \`cargo hack --rust-version check\`. Skip any absent tool/toolchain with a note. If NOTHING could run, return verdict "INCOMPLETE (not run)" naming what was missing — do NOT fail, and do NOT return Approve: no feature combination was actually built. Return "Approve" only if at least one check ran and passed. Report failing feature combinations or MSRV breakage as findings.`,
    },
    {
      label: "deps",
      agent: "",
      prompt: `Audit dependency HYGIENE (distinct from security vulns/licenses): \`cargo tree -d\` (duplicate/conflicting versions) and \`cargo outdated\` (out-of-date deps). Do NOT check unused dependencies here — the unused-crates dimension owns that. Skip any absent tool with a note — do NOT fail; but if NEITHER tool is installed, so no dependency hygiene was actually inspected, return verdict "INCOMPLETE (not run)" naming the missing tools rather than "Approve". Load the rust-ecosystem skill. Report duplicates and notably out-of-date deps as findings.`,
    },
    {
      label: "unused-crates",
      agent: "",
      prompt: `Find UNUSED crates in two classes, then VERIFY each before reporting: (a) ORPHAN workspace members — members that NO other workspace member depends on, excluding binaries and published libraries (from \`cargo metadata\`); (b) UNUSED dependencies — \`cargo machete\` (or \`cargo +nightly udeps\` if absent). For EACH candidate, try HARD to prove it IS used (cfg/feature-gated, macro-only, re-exported, build.rs, dev/bench/example usage, bin/published status) before accepting it; default to "used" when uncertain (recommending deletion of live code is the costly error). Skip any absent tool with a note — do NOT fail. \`cargo metadata\` alone answers class (a), so it is enough to run: if the graph loads and there are no orphan members, that is a real "Approve". But if \`cargo metadata\` itself does not run, so NOTHING was inspected, return verdict "INCOMPLETE (not run)" naming what was missing — not "Approve". Report ONLY verified-unused crates/deps as findings (severity Medium).`,
    },
    {
      label: "tests-cov",
      agent: "",
      prompt: `Assess test effectiveness and docs: \`cargo llvm-cov --summary-only\` if cargo-llvm-cov is installed; build docs cleanly (\`cargo doc --no-deps\`, flag broken intra-doc links) and run doctests (\`cargo test --doc\`). Skip any absent tool with a note — do NOT fail; but if NONE of them ran (no coverage tool, no doc build, no doctests), return verdict "INCOMPLETE (not run)" naming the missing tools rather than "Approve" — nothing was measured. Load the rust-testing skill. Report low-coverage hotspots, broken doc links, and failing doctests as findings.`,
    },
  )

  const results = await fanOut(ctx, jobs)

  // Synthesize through a fresh child session (no agent → the session's default model/persona).
  // One machine-readable label for "this dimension checked nothing" — the same string the leaf
  // agents report and the only one parseVerdict() recognises. A dispatcher-detected death and a
  // dimension's own self-report are the same fact to a reader, and the blob is also the fallback
  // report if synthesis fails, so its verdict must parse too.
  const blob = results.map((r) => `### ${r.label} (${r.ok ? "ran" : "INCOMPLETE (not run)"})\n\n${r.text}`).join("\n\n")
  const synthPrompt = `You are consolidating a Rust audit. Below are the per-dimension results. Produce ONE markdown report — do not invent findings, only merge what is given:

1. An **overall verdict** line — the worst case across dimensions. If any dimension reported the verdict \`INCOMPLETE (not run)\` — because it never executed, or because its tooling was absent — the overall verdict line MUST contain that exact string \`INCOMPLETE (not run)\`.
2. A **dimension → verdict** table. Any dimension that did not check anything gets the verdict \`INCOMPLETE (not run)\` — written exactly that way, with a note naming what was missing — NEVER Approve and never a blank or green cell. Use no other wording for it: a reader must be able to tell "ran, found nothing" from "never ran", and this exact string is the one that is machine-read.
3. **Findings by severity** (Critical first), each tagged with its dimension and location + a one-line fix direction.
4. A short **"Fix first"** list of the highest-leverage items.

RESULTS:
${blob}`

  const report = (await runAgent(ctx, "", synthPrompt).catch(() => blob)) || blob
  await writeRecord(ctx, buildAuditRecord({ results, baseRef, hasUnsafe, synthesisText: report }))
  return report
}
