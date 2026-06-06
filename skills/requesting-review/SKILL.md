---
name: requesting-review
description: How to request a code review — dispatch a reviewer with precise, self-contained context (diff range + what it should do), early and often, then act on the verdict. Use after a feature, before a merge, or when stuck. Triggers: request review, get a code review, review my changes, before merge, dispatch reviewer, review this PR, ready for review.
---

# Requesting Review

Catch issues before they cascade by getting a second set of eyes — early and often, not just at
the end. The reviewer should get a **crafted brief**, not your whole session.

## When to request

- After completing a feature or a meaningful unit of work
- Before merging to the main branch
- When stuck (a fresh perspective unsticks you)
- After a complex bug fix (confirm the fix is sound, not just green)

Review early/often: small reviews catch issues while they're cheap; one giant review at the end
catches them after they've compounded.

## Give the reviewer precise context

A reviewer focused on the *work product* beats one wading through your reasoning. Hand over:

- the **diff range** — `BASE_SHA..HEAD_SHA` (`git merge-base main HEAD` and `HEAD`); the reviewer
  derives the exact range itself (`git diff --merge-base main`), so these SHAs are just for your reference;
- **what it should do** — the requirement/spec it's meant to satisfy (→ `specs`);
- **what you built** — a one-paragraph summary.

Not your chat history. This keeps the review on the code and preserves your own context.

## In craft: dispatch the agents

The review agents are exactly this — delegate to them with the brief:

- **`rust-reviewer`** — runs the cargo gate + reviews the diff against the `rust-review` rubric →
  Approve/Warning/Block.
- **`rust-security-scanner`** — for security-sensitive changes (deps, unsafe, input handling) →
  audit/deny/geiger/semgrep verdict (`rust-security`).
- **`rust-miri`** — when the change touches `unsafe` (→ `rust-unsafe`).

```bash
git merge-base main HEAD   # BASE (for your own reference)
git rev-parse HEAD         # HEAD
# dispatch rust-reviewer with: the requirement + a one-line summary.
# rust-reviewer derives the range itself via `git diff --merge-base main`.
```

## Act on the verdict

- **Block** → fix before doing anything else.
- **Warning** → judge; fix or consciously accept with a reason.
- **Approve** → proceed — but you still confirm green yourself (→ `verification`); a verdict is
  a signal, not proof you skip checking.
- Wrong finding → push back with reasoning (you and the reviewer both serve the goal; don't
  implement a wrong suggestion just because it was raised).

Order multi-item feedback: blocking → simple → complex; test each (→ `receiving-review` for how
to act on the comments without performing).

## Boundaries

- Acting on the feedback (no performative agreement, verify-before-implement) → `receiving-review`.
- The rubric/severity/verdict the reviewer uses → `rust-review`; security → `rust-security`.
- Confirming the result yourself → `verification`.
