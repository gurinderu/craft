---
name: specs
description: Specification by example / BDD / ATDD — turning requirements into concrete Given/When/Then scenarios that double as acceptance tests, driven outside-in. Language-agnostic process skill. Use when turning a feature, user story, or vague requirement into testable behavior before coding, clarifying acceptance criteria, or setting up living documentation. Triggers: spec, specification by example, acceptance criteria, acceptance test, ATDD, BDD, behavior-driven, given when then, gherkin, scenario, user story, requirements to tests, outside-in, living documentation.
---

# Specs — specification by example

A spec, a behavior example, and a test are the same thing said three ways. This skill is the
**process** of turning requirements into Given/When/Then scenarios that are executable and
stay true — independent of language. The mechanics of *running* them live in the per-language
testing skills (Rust: `rust-testing` → BDD; `cucumber`).

## When to Use

- Turning a feature / user story / vague requirement into testable behavior **before** coding
- Pinning down ambiguous acceptance criteria with concrete examples
- Building living documentation that can't drift from the code (the spec is a green test)
- Driving implementation outside-in from acceptance down to units

## The artifact triple

```
requirement / user story        "users can't overdraw their account"
        │  express each rule as concrete examples
acceptance criteria → scenarios  Given balance 100, When withdraw 150, Then rejected
        │  bind steps / write the test
executable acceptance test       runs in CI; red until the behavior exists
        │  drive the code outside-in
implementation                   inner unit-TDD fills in the pieces
```

Because the bottom three are one artifact, the spec can never silently rot: if behavior
changes, the acceptance test goes red. This is **Specification by Example** / **ATDD**.

## From requirement to scenarios

1. **Find the rules.** Decompose the story into discrete business rules ("overdraft is
   rejected", "withdrawal reduces balance", "daily limit applies"). One rule ≠ one scenario —
   a rule usually needs several examples.
2. **Pick examples per rule.** For each rule choose the *happy path*, the *boundaries*
   (exactly at the limit, one past it), and the *one error case that matters*. Don't enumerate
   every input — pick representatives of each equivalence class (see
   [writing-scenarios.md](writing-scenarios.md)).
3. **Get three perspectives** (the "three amigos"): business (is this the right rule?),
   development (can we build it?), testing (how could it break?). Even solo, walk all three —
   the testing lens is where missing scenarios surface.
4. **Write each example as Given/When/Then.**

## Anatomy of a scenario

| Beat | Holds | Rule |
|---|---|---|
| **Given** | the starting context / state | set up the world; may be several |
| **When** | the single action or event under test | **exactly one** per scenario |
| **Then** | the observable outcome(s) | assert results, not internal state |

One `When` per scenario. If you're tempted to write "When X and then I do Y", that's two
scenarios — or Y belongs in `Given`. Keep scenarios independent: no scenario depends on
another having run first.

## Outside-in: acceptance drives units

The two TDD loops nest:

```
OUTER (acceptance / this skill)
  write a failing scenario  ──►  RED
        │
        ▼
  INNER (unit TDD — per-language testing skill)
    red → green → refactor, repeatedly, until…
        │
        ▼
  …the scenario passes      ──►  GREEN  →  next scenario
```

Start from the behavior the user cares about (outer red), then discover the units you need to
make it pass (inner red-green-refactor). You implement only what a failing example demands —
no speculative code.

## Anti-patterns

- **Imperative scenarios** — "click button, type 150, press enter". Write *intent*
  ("When I withdraw 150"), not UI choreography. Details: [writing-scenarios.md](writing-scenarios.md).
- **Testing implementation** — `Then` asserts on a database row or private field instead of
  observable behavior. Assert what the user/caller can see.
- **Conjunction smell** — `And` piling up in `When`, or a scenario covering several rules at
  once. Split it.
- **Incidental detail** — data in the scenario that isn't relevant to the rule. Every value
  shown should matter; hide the rest in `Background` or fixtures.
- **Scenarios no one reads** — full Gherkin tooling without a non-developer audience. Then a
  plain Given/When/Then unit test is the better spec (see `rust-testing`).

## Boundaries

- *Running* scenarios (frameworks, step bindings, `.feature` files) → per-language testing
  skill: `rust-testing` (Given/When/Then tests and `cucumber`). This skill is framework-free.
- Inner unit-level red-green-refactor mechanics → the same per-language testing skill.
- Up-front feature exploration/brainstorming that produces the requirement is upstream of this;
  `specs` starts once you have a requirement to make concrete.
