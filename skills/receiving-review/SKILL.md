---
name: receiving-review
description: How to receive code-review feedback — technical evaluation, not performative agreement. Verify each point against the codebase before implementing, ask when unclear, push back with reasoning when wrong, fix one item at a time with a test. Use when acting on review comments (human or agent). Triggers: code review feedback, review comments, address review, PR feedback, reviewer said, fix review, respond to review.
---

# Receiving Review

Review is a technical signal to evaluate, not a social interaction to smooth over. The rule:
**verify before implementing; act, don't perform.**

## No performative agreement

Don't open with agreement or gratitude — they add nothing and often precede blind, wrong
implementation:

```
❌ "You're absolutely right!"   ❌ "Great point!"   ❌ "Thanks for catching that!"
✅ "Fixed — used a bounded channel in src/queue.rs:40."
✅ "Good catch: the lock spanned the await. Dropped the guard first."
✅ [just make the fix; the diff shows you heard it]
```

The code is the acknowledgment. If you catch yourself typing "Thanks" or "You're right" — delete
it and state the fix.

## The response pattern

```
1. READ      — the whole feedback, before reacting.
2. UNDERSTAND — restate each item in your own words; if you can't, it's unclear → ask.
3. VERIFY    — check the claim against the actual code, not your memory of it.
4. EVALUATE  — is it correct for THIS codebase/stack? does it break anything? why is the current
               code the way it is?
5. RESPOND   — technical acknowledgment, or reasoned pushback. No performance.
6. IMPLEMENT — one item at a time, test each (→ verification). Not a batch you eyeball at the end.
```

## Unclear → stop and ask

If any item is unclear, **don't partially implement** — items are often related, and partial
understanding produces the wrong change.

```
"Fix 1–6." You understand 1,2,3,6; unclear on 4,5.
❌ implement 1,2,3,6 now, ask about 4,5 later
✅ "Clear on 1,2,3,6. Need clarification on 4 and 5 before I start — they may affect 2."
```

## When to push back

Reviewers aren't always right. Push back — with technical reasoning, not defensiveness — when the
suggestion:

- breaks existing behavior or tests;
- is wrong for this stack/codebase;
- adds an unused feature (**YAGNI** — `grep` for actual usage first; if unused, propose removing
  rather than "implementing properly");
- is based on missing context (the reviewer didn't see why it's done this way);
- conflicts with a prior architectural decision — then stop and discuss, don't silently comply.

Push back by referencing tests/code and asking specific questions, not by asserting. If you were
the one who was wrong, say so factually and move on — no long apology, no defending the pushback:
"Checked — you're right, `get` can return `None` here. Fixing."

## Source matters

- **Trusted partner (the user):** implement after understanding; still ask if scope is unclear;
  skip the performance, just act.
- **External / automated reviewer:** be skeptical but check carefully — verify each claim against
  the code before acting; a confident comment can still be wrong for your context.

## Order of work

Clarify everything first, then: blocking issues (breakage, security) → simple fixes (typos,
imports) → complex fixes (logic, refactor). Test each individually; confirm no regressions at the
end (→ verification).

## Boundaries

- Confirming each fix actually works → `verification` (evidence, not "should be fixed now").
- If a finding is a real bug, debug it properly before patching → `debugging`.
- The rubric a Rust reviewer applied (and what the severities mean) → `rust-review`.
- Requesting a review in the first place → `requesting-review`.
