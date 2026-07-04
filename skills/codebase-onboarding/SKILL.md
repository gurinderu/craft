---
name: codebase-onboarding
description: >-
  Quickly understand an unfamiliar codebase before changing it — map the structure, find the entry points and seams, trace one real flow end to end, and confirm understanding by building/testing. Use when dropped into a new or large repository, or before a change in code you don't know. Language-agnostic, with Rust hooks. Triggers: where do I start, how does this work, trace the flow, get oriented, onboard.
---

# Codebase Onboarding

Don't start editing code you don't understand — you'll fight conventions you can't see. Spend the
first hour building a map, not patches. The goal: know **where things are**, **how one real
request flows**, and **how to run it**, before you touch anything.

## When to Use

- Dropped into a new or large repository
- About to change a part of the system you don't know
- Reviewing a big PR in unfamiliar code

## The orientation pass (outside-in)

```
1. ORIENT   — README, docs/, CONTRIBUTING, the build/run commands. How is it meant to be used?
2. SHAPE    — top-level layout: where's the entry point, the modules, the tests, the config?
3. ENTRY    — find main()/lib root and the public surface; that's the spine.
4. TRACE    — pick ONE real flow (a request, a command, a job) and follow it end to end.
5. SEAMS    — note the boundaries: where it talks to DB/network/other services.
6. CONFIRM  — build it, run the tests, run it. Understanding you can't execute is a guess.
```

Read **breadth-first**, not line-by-line: skim to build the map, then go deep only on the path
you need to change.

## Let the tools draw the map

- **Structure**: `git ls-files | head`, the dependency manifest (`Cargo.toml` workspace members),
  directory tree. The folder names are the architecture's first claim.
- **Entry points**: `main.rs`/`lib.rs`, `[[bin]]`/`[lib]` targets; for a service, the router/route
  table is the index of features.
- **Activity & hotspots**: `git log --oneline -20` (what's changing now), `git log --format= --name-only | sort | uniq -c | sort -rn | head` (the files that change most — usually the core).
- **Navigation**: rust-analyzer / your LSP — go-to-definition and find-references to follow a
  symbol instead of grepping blindly (the operations and the no-LSP fallbacks → `rust-navigation`).
  `cargo doc --open` renders the public API as a browsable map.
- **Find a flow**: grep an endpoint string / CLI subcommand / log message, then follow the calls.

## Trace one real flow

Pick a single concrete behavior and follow it through every layer — request → handler → service
→ repository → DB, or CLI arg → command → work → output. One full trace teaches more than reading
ten files in isolation: it reveals the layering, the error handling, and the conventions all at
once. (In a craft-style codebase that's the inbound adapter → domain → outbound adapter path of
`rust-architecture`.)

## Confirm by running

You don't understand it until you can build and exercise it:

```bash
cargo build           # does it compile as-is?
cargo test            # do the tests pass? (they're also runnable documentation)
cargo run -- ...      # run a real path
cargo tree            # what does it actually depend on?
```

(non-Rust: substitute the project's build/test/run/dependency commands — npm/go/make, etc.)

The tests are the best spec of intended behavior (→ `specs`, `rust-testing`) — read a few to see
how the authors expect the code to be used.

## Anti-patterns

- **Editing before mapping** — changing code whose conventions you haven't seen.
- **Reading top-to-bottom** — drowning in detail before you have the shape.
- **Trusting names/comments over behavior** — verify against a run; comments rot.
- **Skipping the build** — assuming it works the way you read it.

## Boundaries

- Once you need to *change* it: structural moves → `rust-architecture`/`refactoring`; a bug to
  chase → `debugging`; confirming your change → `superpowers:verification-before-completion`.
- For a persistent, queryable knowledge map of a very large codebase, dedicated
  indexing/knowledge-graph tooling goes deeper than this first-hour pass.
