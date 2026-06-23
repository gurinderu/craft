# Elastic deep review engine — design

**Date:** 2026-06-23
**Status:** Approved, ready for implementation plan
**Composes with:** [CI-aware mechanical gate](2026-06-23-ci-aware-gate-design.md) — the gate is one
phase of this engine.

## Problem

The current review finds far from everything ("находится далеко не всё"). Root causes, from
reading `agents/rust-reviewer.md`, `skills/rust-review/SKILL.md`, and `workflows/rust-audit.js`:

1. **One agent, one pass, one lens.** `rust-reviewer` walks the whole broad rubric in a single
   read. `rust-audit` only fans out by *dimension*; its review dimension is still one agent. LLMs
   miss far more in one broad pass than in several narrow focused passes.
2. **Terseness suppresses recall.** The agent is told "be terse; the value is in catching real
   issues, not volume" and the rubric says "a finding without a location isn't actionable." Good
   for precision, but the agent self-censors borderline findings instead of surfacing them.
3. **Diff-only reading.** "Read surrounding context as needed" is soft; bugs living at the seam
   between the change and its callers/invariants/error paths are systematically missed.
4. **No second look.** No adversarial verifier, no completeness critic, no loop-until-dry.
5. **Model tier.** The semantic pass runs on sonnet.

## Decisions (from brainstorming)

1. **Deep-only, elastic — one review path.** Drop the idea of a separate cheap single-agent tier.
   A single workflow engine scales its depth to the diff (size, touched categories) and to the
   token budget. Small diffs run cheap (few lenses, one round, single skeptic); large diffs run
   the full fan-out + loop + multi-vote verification.
2. **`rust-reviewer` is repurposed, not deleted.** It becomes the per-lens worker: the workflow
   dispatches N instances, each given a lens-scoped brief. What retires is the *single-pass
   whole-diff* orchestration, not the agent. The agent remains manually dispatchable for an
   ad-hoc non-workflow review.
3. **Confidence tiers, no censorship.** Findings are reported as **Confirmed** (located, verified
   — drive the verdict) and **Suspected** (borderline / survived verification but not confirmed —
   surfaced, never dropped). The verdict is driven only by Confirmed CRITICAL/HIGH, so Suspected
   never causes a false Block.
4. **Adversarial verification.** Each finding faces skeptics prompted to refute; majority refute
   → drop or demote to Suspected. Rigor scales: one skeptic by default, three-vote consensus for
   CRITICAL/HIGH.
5. **Quality levers A+B+C+D all included** (see below).

## Design

### Entry & ergonomics

- New `workflows/rust-review.js` is the single review path. The name intentionally matches the
  `rust-review` skill (separate registries) — same concept, the workflow orchestrates, the skill
  owns the rubric.
- A review request ("сделай ревью", etc.) launches this workflow in the background; the main loop
  continues and reports the verdict on completion — the same background ergonomics as today, now
  multi-agent. Routing this from `CLAUDE.md` relies on the "project instructions tell you to call
  Workflow" opt-in path, which is legitimate here because it is the user's explicit design.
- `rust-audit.js` calls this workflow nested for its review dimension:
  `workflow('rust-review', {...})`. Nesting is one level — this workflow must not itself call
  another workflow.

### Pipeline

**1. Scout (haiku, cheap).**
Resolve the diff base + range (reuse the rust-audit scout logic). Classify the diff: changed
files, size bucket (small / medium / large), which rubric categories are plausibly in play
(`unsafe`? async/threads? SQL? public API? money? FFI?), whether the crate is a **library** (→
semver-checks), whether it is security-sensitive. Pull **intent** from the brief/args and
**git-churn** (recently/often-changed files) to focus attention. Emit a plan:

| bucket | lenses | maxRounds | verifyVotes | model |
|---|---|---|---|---|
| small | touched categories only (min 2) | 1 | 1 | sonnet |
| medium | relevant lenses | 2 | 1 (3 for CRITICAL/HIGH) | mixed |
| large | all lenses | until-dry (cap ~3) | 3 for CRITICAL/HIGH | opus on lenses/verify |

The plan also scales to `budget` when a token target is set.

**2. Gate + tool grounding (lever A).**
Establish the gate signal CI-aware (per the gate spec): consume green required CI checks for
build/test/clippy/fmt; run audit/deny locally. A red mechanical gate → Block early, stop.
Then run, scoped to the changed crates, real tools whose diagnostics become **seed findings** fed
into dedup/verify like any other finding:

- `cargo clippy` with `-W clippy::pedantic -W clippy::nursery` (beyond the `-D warnings` gate).
- `cargo semver-checks check-release` when the crate is a published library.

Tool output is deterministic and high-signal — it grounds the review in facts rather than LLM
guesses. Each seed finding still passes through verification (a pedantic lint may be intentional).

**3. Lenses (fan-out, parallel).**
One `rust-reviewer` instance per selected lens, each owning ONE slice and blind to the others:

- safety / injection / secrets
- errors / panics / `Result` discipline
- ownership / lifetimes
- concurrency / async
- performance
- API / idioms / docs
- tests & coverage — **quality, not just presence** (lever B): do new tests exercise behavior and
  error paths, or are they vacuous? In the large bucket, optionally run `cargo mutants` on the
  changed files, time-boxed.
- **intent / spec conformance** (lever B): does the change actually do what the brief/spec claims?
  Catches the costliest class — correct-looking code, wrong behavior. Requires intent in the brief.

Each lens does **context expansion** (trace callers / impls / error paths via Grep/Glob and LSP
through `rust-navigation`) and emits **blast-radius** (lever D): for each changed public symbol,
how many callers are affected, with a breaking-change flag.

**4. Loop-until-dry.** Re-dispatch lenses for further rounds until a round adds nothing new
(dedup by file+line+normalized-claim against everything seen) or `maxRounds` is hit. Small bucket
= 1 round, no loop.

**5. Dedup (barrier).** Merge lens findings, seed (tool) findings, and rounds; dedup by
(file, line, normalized claim).

**6. Verify (adversarial + anti-hallucination, lever C).** Each deduped finding faces skeptics
prompted to refute (default to refuted when uncertain); `verifyVotes` from scout. Additionally a
**self-verification** step re-reads the cited line and confirms (a) the code actually says what
the finding claims — kills hallucinated `file:line` — and (b) the path is reachable in production,
not test/example code. Majority refute → drop or demote to Suspected.

**7. Calibrate + completeness critic (lever C).** A pass normalizes severities across lenses (the
same kind of issue should not be Critical from one lens and Medium from another). A completeness
critic asks "which category/claim was not covered, which referenced file was not read?" and spawns
targeted follow-up where it finds a gap.

**8. Synthesize.** One markdown report: overall verdict (driven by Confirmed CRITICAL/HIGH) + gate
provenance + Confirmed findings by severity + a Suspected section + a "fix first" list. Optionally
(lever D) post Confirmed findings as inline PR comments via `gh` (mirroring the `code-review`
skill's `--comment`).

### Files to change

- `workflows/rust-review.js` — NEW: the elastic engine (scout → gate+grounding → lenses → loop →
  dedup → verify → calibrate/critic → synthesize).
- `agents/rust-reviewer.md` — repurpose as the per-lens worker: accept a lens-scoped brief, require
  context expansion + blast-radius, emit Confirmed/Suspected tiers. No longer dispatched standalone
  for a whole diff by default; remains manually usable.
- `skills/rust-review/SKILL.md` — add the lens catalog, the confidence tiers (Confirmed/Suspected),
  the adversarial + self-verification protocol, the context-expansion expectation, and the tool-
  grounding list; change the verdict to be driven by Confirmed; note the workflow is the review
  entry point.
- `workflows/rust-audit.js` — review dimension delegates to `workflow('rust-review', {...})`.
- `CLAUDE.md` — routing table: default review → `rust-review` workflow (background); note the
  multi-agent implication.
- `MAP.md` — document the workflow, the lenses, the levers, and the single-pass retirement.

## Non-goals

- No separate cheap review tier — elasticity replaces it.
- No auto-fixing — the engine judges; the author applies fixes (craft principle). Inline PR
  comments are findings, not patches.
- `cargo mutants` and `cargo semver-checks` are best-effort: absent tool → skip that grounding,
  degrade gracefully (never fail the review).

## Risk

- Every review is now a workflow (≥2 agents even for a trivial diff). Scout keeps small diffs
  minimal; accepted as the cost of a single coherent high-recall path.
- Higher recall raises false positives; the confidence tiers + adversarial + self-verification
  passes are the counterweight, and the verdict is driven only by Confirmed.
- Tool grounding depends on optional binaries (`cargo-semver-checks`, `cargo-mutants`); their
  absence degrades to LLM-only review for that axis, never an error.

## Open input

If the user's Rust repos have a stable CI job-naming convention (shared with the gate spec) or
conventions for which crates are published libraries, scout's classification should be tuned to
them. Absent that, scout uses safe defaults (unrecognized → treat as application crate, run the
full local grounding).
