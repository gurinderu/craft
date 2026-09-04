// Mirrors workflows/rust-audit.js (slim port): scout → fan out the agent dimensions (Miri only if
// unsafe) plus the whole-project tool dimensions (crate-decomposition, semver, build-matrix, deps,
// unused-crates, tests-cov, on the default session model) → synthesize. The Claude-Code-only
// elastic rust-review engine has no opencode equivalent, so the "review" dimension is a single-pass
// rust-reviewer (no per-crate / inter-crate-contract fan-out); see opencode/README.md parity caveats.
import type { PluginCtx } from "./index.ts"
import { fanOut, runAnswering, type Job } from "./orchestrator.ts"
import { buildAuditRecord, hasVerdictLine, writeRecord } from "./run-record.mjs"

// Every dimension — and the synthesis — ends with ONE machine-readable line from a closed
// vocabulary. run-record.mjs's parseVerdict() reads the LAST such line, which is what keeps a
// quoted instruction or an emphasised adjective from deciding the verdict. Written as a placeholder
// (`VERDICT: X`) on purpose: a literal example line here could be echoed back as the final line.
const VERDICT_RULE =
  "\n\nFINALLY, after everything else, end your report with ONE line on its own, in exactly this " +
  "form: `VERDICT: X` — where X is exactly one of the four tokens APPROVE, WARNING, BLOCK, " +
  "INCOMPLETE (uppercase, no other wording). Use INCOMPLETE when nothing was actually checked — " +
  "the tooling was absent, or nothing executed — never APPROVE in that case: an APPROVE is a claim " +
  "about what was not found, and it only holds over what was actually looked at. Map any " +
  "domain-specific rating you used above onto these four (Healthy/Clean → APPROVE, Concerns → " +
  "WARNING, At-risk/UB-found → BLOCK). Write nothing after that line — it is machine-read."

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
      prompt: `Review the Rust diff for mergeability using the rust-review rubric. ${diffNote} Report every finding with severity and confidence (coverage, not filtering), then your Approve/Warning/Block verdict.${VERDICT_RULE}`,
    },
    {
      label: "architecture",
      agent: "rust-architecture-reviewer",
      prompt: `Audit the architecture of this whole Rust project: build the crate/module dependency graph and judge it in both directions (layer leaks/god modules vs ghost abstractions/over-layering). Return your Healthy/Concerns/At-risk rating and findings. If the graph could not be built at all — no manifest is readable and \`cargo metadata\` does not run — nothing was judged: return verdict "INCOMPLETE (not run)" naming what was missing, NOT Healthy.${VERDICT_RULE}`,
    },
    {
      label: "security",
      agent: "rust-security-scanner",
      prompt: `Run the Rust security toolchain (cargo-audit, cargo-deny, cargo-geiger, semgrep — whatever is installed) and consolidate into a severity-ranked verdict and findings. Note any absent tools. If NONE of the tools is installed, so nothing was actually scanned, return verdict "INCOMPLETE (not run)" and name the missing tools — a scan that ran nothing is not an Approve.${VERDICT_RULE}`,
    },
  ]
  if (hasUnsafe) {
    jobs.push({
      label: "miri",
      agent: "rust-miri",
      prompt: `This workspace contains unsafe code. Run its tests under Miri and report any undefined behavior against the rust-unsafe rubric. Return a Clean / UB-found verdict, or "INCOMPLETE (not run)" if the nightly toolchain or miri itself is unavailable so nothing was executed under Miri — an unrun Miri is NOT Clean. Return findings.${VERDICT_RULE}`,
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
      prompt: `Judge this Rust workspace's crate boundaries: recommend where code should be EXTRACTED into its own crate, or where an over-split crate should be MERGED back (build on \`cargo metadata\`). For each recommendation give the DRIVER, the BOUNDARY, and the HOW. Recommend only — do not move code. Load the rust-ecosystem skill (crate-extraction). Return a Healthy/Concerns/At-risk verdict and findings.${VERDICT_RULE}`,
    },
    {
      label: "semver",
      agent: "",
      prompt: `Check public-API semver compatibility across PUBLISHED crates: run \`cargo semver-checks check-release\` if installed. If cargo-semver-checks is absent, say so and return verdict "INCOMPLETE (not run)" with a one-line note naming what was missing — do NOT fail, and do NOT return Approve: nothing was checked. If the tool IS available but there is no published library crate to check, that is a real, complete answer — return "Approve" with a note that the workspace publishes no library. Load the rust-ecosystem skill. Report breaking changes vs the published baseline as findings.${VERDICT_RULE}`,
    },
    {
      label: "build-matrix",
      agent: "",
      prompt: `Check the build across feature combinations and the MSRV. If \`cargo-hack\` is installed: \`cargo hack check --feature-powerset --no-dev-deps\`, plus \`cargo check --no-default-features\` and \`cargo check --all-features\`. For MSRV read \`rust-version\` from Cargo.toml and run \`cargo hack --rust-version check\`. Skip any absent tool/toolchain with a note. If NOTHING could run, return verdict "INCOMPLETE (not run)" naming what was missing — do NOT fail, and do NOT return Approve: no feature combination was actually built. Return "Approve" only if at least one check ran and passed. Report failing feature combinations or MSRV breakage as findings.${VERDICT_RULE}`,
    },
    {
      label: "deps",
      agent: "",
      prompt: `Audit dependency HYGIENE (distinct from security vulns/licenses): \`cargo tree -d\` (duplicate/conflicting versions) and \`cargo outdated\` (out-of-date deps). Do NOT check unused dependencies here — the unused-crates dimension owns that. Skip any absent tool with a note — do NOT fail; but if NEITHER tool is installed, so no dependency hygiene was actually inspected, return verdict "INCOMPLETE (not run)" naming the missing tools rather than "Approve". Load the rust-ecosystem skill. Report duplicates and notably out-of-date deps as findings.${VERDICT_RULE}`,
    },
    {
      label: "unused-crates",
      agent: "",
      prompt: `Find UNUSED crates in two classes, then VERIFY each before reporting: (a) ORPHAN workspace members — members that NO other workspace member depends on, excluding binaries and published libraries (from \`cargo metadata\`); (b) UNUSED dependencies — \`cargo machete\` (or \`cargo +nightly udeps\` if absent). For EACH candidate, try HARD to prove it IS used (cfg/feature-gated, macro-only, re-exported, build.rs, dev/bench/example usage, bin/published status) before accepting it; default to "used" when uncertain (recommending deletion of live code is the costly error). Skip any absent tool with a note — do NOT fail. \`cargo metadata\` alone answers class (a), so it is enough to run: if the graph loads and there are no orphan members, that is a real "Approve". But if \`cargo metadata\` itself does not run, so NOTHING was inspected, return verdict "INCOMPLETE (not run)" naming what was missing — not "Approve". Report ONLY verified-unused crates/deps as findings (severity Medium).${VERDICT_RULE}`,
    },
    {
      label: "tests-cov",
      agent: "",
      prompt: `Assess test effectiveness and docs: \`cargo llvm-cov --summary-only\` if cargo-llvm-cov is installed; build docs cleanly (\`cargo doc --no-deps\`, flag broken intra-doc links) and run doctests (\`cargo test --doc\`). Skip any absent tool with a note — do NOT fail; but if NONE of them ran (no coverage tool, no doc build, no doctests), return verdict "INCOMPLETE (not run)" naming the missing tools rather than "Approve" — nothing was measured. Load the rust-testing skill. Report low-coverage hotspots, broken doc links, and failing doctests as findings.${VERDICT_RULE}`,
    },
  )

  // Asked of EVERY dimension in one place rather than repeated per job: every prompt above ends with
  // VERDICT_RULE, so carrying that line is what it means for any of them to have answered. Attaching
  // it per job would be ten chances to forget one, and the one forgotten is the one that reports
  // Approve on a dead session. The predicate comes FROM the parser that will later read the same
  // line, so the gate and the reader cannot disagree about what an answer looks like.
  const results = await fanOut(ctx, jobs.map((j) => ({ ...j, answered: hasVerdictLine, requires: "VERDICT: line" })))

  // Synthesize through a fresh child session (no agent → the session's default model/persona).
  // One machine-readable label for "this dimension checked nothing" — a dispatcher-detected death
  // and a dimension's own self-report are the same fact to a reader. The blob is also the fallback
  // report if synthesis fails; its own last VERDICT: line is then whatever the last dimension
  // wrote, which is harmless because buildAuditRecord() rolls the record verdict up worst-wins over
  // every dimension rather than trusting a single text scan.
  const blob = results.map((r) => `### ${r.label} (${r.ok ? "ran" : "INCOMPLETE (not run)"})\n\n${r.text}`).join("\n\n")
  // The blob ends with whatever VERDICT: line the LAST dimension wrote — commonly APPROVE. Handing
  // it over as the report when synthesis dies therefore hands the reader an approval nobody made.
  // The run record was already safe (worst-wins over dimensions); the text a human reads was not.
  const unsynthesized = (why: string) =>
    `## ⚠️ INCOMPLETE (not run) — the audit was not consolidated\n\n${why}\n\nThe synthesis step did not return a report, so what follows is the raw per-dimension output. Nothing here is an approval: read each dimension's own verdict below, and note that any \`VERDICT:\` line at the very end belongs to the last dimension, not to the audit.\n\n${blob}`
  const synthPrompt = `You are consolidating a Rust audit. Below are the per-dimension results. Produce ONE markdown report — do not invent findings, only merge what is given:

1. An **overall verdict** line — the worst case across dimensions. If any dimension reported the verdict \`INCOMPLETE (not run)\` — because it never executed, or because its tooling was absent — the overall verdict line MUST contain that exact string \`INCOMPLETE (not run)\`.
2. A **dimension → verdict** table. Any dimension that did not check anything gets the verdict \`INCOMPLETE (not run)\` — written exactly that way, with a note naming what was missing — NEVER Approve and never a blank or green cell. Use no other wording for it: a reader must be able to tell "ran, found nothing" from "never ran", and this exact string is the one that is machine-read.
3. **Findings by severity** (Critical first), each tagged with its dimension and location + a one-line fix direction.
4. A short **"Fix first"** list of the highest-leverage items.

RESULTS:
${blob}${VERDICT_RULE}`

  // Held to the same standard as every dimension: the synth prompt ends with the same VERDICT_RULE,
  // so text without that line is not a consolidation — it is a refusal or a preamble, and treating
  // it as the report filed an Approve for a run nobody consolidated.
  // The prompt embeds `blob`, which carries every dimension's real VERDICT: line — so a synthesis
  // that refuses while quoting the results back satisfies any verdict-line gate and is accepted as
  // the consolidated report. The record's roll-up is worst-wins over dimensions, so this is a
  // report-TEXT hazard rather than a false approval, but it is the same echo hole the plan marker
  // just closed. A consolidation restates; it does not reproduce. Verbatim republication of the
  // input is therefore not an answer, whatever line it ends with.
  // What separates republication from consolidation, sharply: the per-dimension SECTION HEADINGS.
  // An echo carries the blob's structure with it; a consolidation is asked for a dimension→verdict
  // table and has no reason to reproduce `### security (ran)` verbatim. Overlap fraction was tried
  // first and is the wrong measure — the prompt orders "do not invent findings, only merge what is
  // given" and asks for each finding tagged with its location, so a faithful merge of a small audit
  // is mostly lines lifted from the input, and any threshold low enough to catch an echo also threw
  // away the real thing. A false not-run here discards the whole audit under an INCOMPLETE banner,
  // which is the expensive error everywhere else on this branch.
  const headings = blob.split("\n").map((l) => l.trim()).filter((l) => /^###[ \t]/.test(l))
  // MORE THAN ONE — stated as the floor it is, not as a measured number. One heading quoted in
  // passing is something a consolidation may legitimately do; carrying the input's section headings
  // is reproducing its structure. Only the lower side is pinned by a test, and raising 2 to 3 or 5
  // breaks nothing, so calling 2 "measured" would be a claim no falsifier can reach — which is
  // exactly what was wrong with the overlap fraction it replaced.
  const echoed = (t: string) => headings.length >= 2 && headings.filter((h) => t.includes(h)).length >= 2
  const answeredSynthesis = (t: string) => hasVerdictLine(t) && !echoed(t)

  const synthesis = await runAnswering(ctx, "", synthPrompt, answeredSynthesis, undefined, "VERDICT: line").catch(
    (e) => ({ ok: false, text: "", note: `The synthesis call itself threw: ${e instanceof Error ? e.message : String(e)}` }),
  )
  // WHY it died, in the reader's hands. A refusal, a twenty-minute timeout and an errored session are
  // three different things to do next, and they used to print the same sentence.
  const report = synthesis.ok ? synthesis.text : unsynthesized(synthesis.note)
  // The record is told the synthesis died, rather than left to infer it from text: the fallback
  // report embeds the dimension blob, so reading a verdict out of it picks up the LAST dimension's
  // line and files an Approve for a run that was never consolidated.
  await writeRecord(ctx, buildAuditRecord({ results, baseRef, hasUnsafe, synthesisText: report, synthesized: synthesis.ok }))
  return report
}
