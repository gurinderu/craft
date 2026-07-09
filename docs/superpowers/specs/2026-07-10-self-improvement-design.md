# Self-improving review engine — design

**Date:** 2026-07-10
**Status:** Draft — Phase 1 (harvester) implemented; Phases 2+ are proposals.
**Builds on:** [Observability — craft run records](../../observability.md), the generic review engine
([2026-07-08-generic-review-design.md](2026-07-08-generic-review-design.md)).
**Prior art:** [NousResearch/hermes-agent-self-evolution](https://github.com/NousResearch/hermes-agent-self-evolution)
— GEPA (Genetic-Pareto prompt evolution) + DSPy that reads execution traces to learn *why* a step
failed, mutates the skill/prompt, gates on tests + size + semantic preservation, and opens a PR.

## Problem

craft's review quality lives in prose that is never measured against outcomes: the lens briefs
(`lensBrief` in `workflows/review.js`), the rule catalogs (`rules.md` in the `rust-review` /
`nix-review` skills), and the reviewer-agent system prompts. When a lens over-fires (its findings are
mostly refuted downstream) or under-delivers (it runs but never confirms anything) or is fragile
(keeps failing to return), nothing surfaces it and nothing closes the loop. Hermes shows the shape of
a fix; craft already emits most of the raw material.

## The signal we already have

Every review/audit run writes a record to `~/.craft/runs/` with, per run:

- `verification {candidates, confirmed, refuteRate}` — how much of what finders produced survived
  adversarial verification. High refute rate ⇒ noisy finders.
- `notRun[]` — lenses/dimensions that failed to return. This is the **fragility** signal (the
  missing-`craft:rust-reviewer` agent bug shows up here as lenses dropping to NOT RUN).
- `dimensions[]` — per-lens *confirmed* finding counts + severity mix. A lens that runs across many
  records but confirms nothing is miscalibrated or redundant.
- `verdict`, `scout` (size, lens set, model), `outputTokens` (cost).

**Phase 1 — the harvester (this PR).** `lib/analyze-runs.mjs` reads the store and ranks exactly these
signals: fragility (NOT RUN frequency), noise (per-workflow refute rate), yield (per-dimension
confirmed volume), plus verdict/INCOMPLETE/cost. `aggregate(records)` is pure and unit-tested; the
CLI (`node lib/analyze-runs.mjs`) prints the report. This is the "diagnose" stage — no mutation yet.

## The gap before a full loop

The records log *counts*, not *content*, and only at run granularity for verification:

1. **No per-lens refute rate.** `verification` is run-level; `dimensions[]` carries only *confirmed*
   counts, not per-lens candidates/refutes. So we can see a lens's yield but not its precision. Fix:
   extend the record with a per-lens `{candidates, confirmed, refuted}` block (the numbers already
   exist inside `verifyPool`; they're just not attributed per lens when merged into the run record).
2. **No finding text.** GEPA needs *why* a finding was refuted, not just that it was. Fix: optionally
   persist refuted findings' `{title, why, file, refutationReason}` (behind a flag — this is larger
   and privacy-sensitive, so opt-in per project).
3. **No labeled eval set.** The hardest dependency (Hermes hits the same wall). Fix: bootstrap a small
   corpus of past diffs with a human-blessed expected verdict/finding set, stored under
   `docs/superpowers/evals/` — start by hand-labeling ~10 diffs craft has already reviewed.

## Phase 2+ — the loop (proposal, not built)

```
harvest (~/.craft/runs)  →  diagnose (analyze-runs)  →  pick worst lens/rule
      →  mutate its lensBrief / rules.md entry (GEPA-style, trace-grounded)
      →  gate: node --test  +  re-run review on the labeled corpus (no worse verdict/precision)
             +  skill-size limit  +  semantic-preservation check
      →  open a PR (never auto-merge)
```

- **Mutation target** is always a text artifact craft already owns — a `lensBrief` string or a
  `rules.md` catalog entry — never engine control flow. Keeps changes reviewable and reversible.
- **Gate** reuses what exists: `node --test` (CI), `lib/check-workflows.mjs` (parse), and a new
  corpus replay. A mutation that raises refute rate or drops a known-good finding is rejected.
- **Human-in-the-loop** always: the loop's output is a PR, matching craft's existing flow.

## Non-goals

- No model fine-tuning / RL — this is prompt/rubric evolution over API calls, like Hermes (~$2-10/run).
- No auto-merge. No mutation of engine control flow (`review.js` orchestration), only its text knobs.
- Phase 1 does not require the schema changes in §"gap" — it works on today's records; the schema
  work is the prerequisite for Phases 2+.

## Open questions

- Where does the labeled corpus live and who blesses it? (Proposed: `docs/superpowers/evals/`, hand-seeded.)
- Is finding-text capture acceptable for private repos, or eval-corpus-only?
- Do we mutate reviewer-agent system prompts (`agents/*.md`) too, or only the in-engine `lensBrief` /
  skill `rules.md`? (Start with the latter — smaller blast radius.)
