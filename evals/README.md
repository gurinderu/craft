# Skill-triggering evals

A corpus for measuring the #1 failure mode of a keyword-dense collection: **mis-triggering** — the
wrong skill fires, or the right one doesn't. Anthropic's guidance is to build evals *before*
trusting a skill's `description`, then measure should-trigger vs should-not-trigger. This directory
is that measurement, kept as a manual/local harness (it needs a live model — see "Not in CI" below).

## The corpus

`evals.json` is a JSON array of cases in the Anthropic rubric shape:

```json
{
  "skills": ["rust-review"],
  "query": "<a realistic user prompt>",
  "expected_behavior": ["<assertion>", "<assertion>"]
}
```

- `skills` — the skill(s) that *should* be selected for this query (its id = the directory under
  `skills/`).
- `query` — a realistic prompt a user would type.
- `expected_behavior` — assertions to grade the run against.

The corpus deliberately mixes two kinds of case:

- **should-trigger** — the query clearly wants a given skill; it must fire and do its job.
- **should-NOT-trigger** — an *adjacent* query that shares keywords with a skill but must resolve to
  a **different** skill (or none). These are where description keyword-stuffing causes false
  triggers, e.g. "review my flake" → `nix-review`, not `rust-review`; "criterion benchmark" →
  `rust-performance`, not `rust-testing`; a borrow-checker `E0499` → `rust-ownership`, not
  `debugging`. In a no-trigger case, `skills` names the skill that *should* win and the
  `expected_behavior` states which skill must **not** fire.

Covered high-traffic skills: `rust-review`, `nix-review`, `debugging`, `addressing-findings`,
`rust-testing`, `rust-errors`, `rust-ownership`, `rust-concurrency`, `rust-performance`, `specs`.

## Running it

The evals run against a live model through the **`skill-creator`** skill (its eval / benchmark
mode). From a Claude Code session with `skill-creator` available:

1. **A/B triggering** — for each case, `skill-creator` runs the `query` in an isolated subagent and
   checks whether the expected skill from `skills` is selected and the `expected_behavior`
   assertions hold. The no-trigger cases catch false positives.
2. **Description tuning** — when a case mis-fires, iterate on the *offending* skill's `description`
   frontmatter (tighten triggers, disambiguate overlapping keywords) and re-run until green. Note:
   editing skill descriptions is out of scope for this directory — it owns the corpus, not the
   skills.
3. **Benchmark** — run the whole corpus repeatedly for a pass-rate + variance number to track
   triggering accuracy over time.

Invoke it with the `skill-creator` skill and point it at `evals/evals.json`.

## Not in CI

Skill-triggering evals need a live model/API, so they are **intentionally not wired into
`.github/workflows/ci.yml`** — they're a manual/local harness you run when a description changes or a
skill is added.

What CI *does* guard is the corpus's **shape**, statically, via `lib/check-evals.mjs`
(`node lib/check-evals.mjs`, also asserted by `node --test`): valid JSON, well-formed cases, and
every referenced skill id resolves to a real `skills/<id>/`. That catches a renamed/deleted skill
leaving a dangling pointer — without needing a model.
