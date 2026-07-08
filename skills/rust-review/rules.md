# Rust review — rule catalog

Stable IDs for the severity checklist in `SKILL.md`. A finding that maps to a rule **cites its ID**
(e.g. `CON-003`) so it is addressable, dedup-able across rounds, and greppable in a report. IDs are
append-only: never renumber or reuse a retired ID.

This catalog **mirrors** the `SKILL.md` checklist — the checklist is the prose, this is the index.
Severities match; `strict` mode escalates the `MNT-*` rules to a presumption of block. Not every
finding maps to a catalog rule (novel issues are fine and encouraged — report them without an ID).

| ID | Severity | Rule | Fix skill |
|---|---|---|---|
| **SAF-001** | CRITICAL | `unwrap`/`expect`/`panic!`/`todo!`/`unreachable!` on a reachable production path | `rust-errors`, `rust-idioms` |
| **SAF-002** | CRITICAL | `unsafe` block without a `// SAFETY:` comment justifying every invariant | `rust-unsafe` |
| **SAF-003** | CRITICAL | SQL/command built by string interpolation of untrusted input (injection) | `rust-security` |
| **SAF-004** | CRITICAL | User-controlled path used without canonicalize + prefix check (traversal) | `rust-security` |
| **SAF-005** | CRITICAL | Hardcoded secret / key / token / password in source | `rust-security` |
| **SAF-006** | CRITICAL | Deserializing untrusted input without size/depth limits | `rust-security` |
| **ERR-001** | CRITICAL | Recoverable failure handled with `panic!`/`unwrap` instead of `Result` | `rust-errors` |
| **ERR-002** | CRITICAL | `let _ = result;` silently dropping a `#[must_use]` / error value | `rust-errors` |
| **ERR-003** | MEDIUM | Library returns `Box<dyn Error>` / `anyhow::Error` instead of a typed error | `rust-errors` |
| **OWN-001** | HIGH | `.clone()` added to silence the borrow checker without understanding why | `rust-ownership` |
| **OWN-002** | HIGH | Takes `String` where `&str`/`impl AsRef<str>` suffices; `Vec<T>` where `&[T]` suffices | `rust-ownership` |
| **OWN-003** | HIGH | Explicit lifetimes where elision applies | `rust-ownership` |
| **CON-001** | HIGH | Blocking call (`thread::sleep`, blocking I/O, `std::fs`) inside an `async` fn | `rust-concurrency` |
| **CON-002** | HIGH | Unbounded channel without justification (prefer bounded back-pressure) | `rust-concurrency` |
| **CON-003** | HIGH | Lock held across an `.await` | `rust-concurrency` |
| **CON-004** | HIGH | Inconsistent lock acquisition order (deadlock risk) | `rust-concurrency` |
| **CON-005** | HIGH | Missing `Send`/`Sync` where the type crosses threads | `rust-concurrency` |
| **PER-001** | MEDIUM | Allocation inside a hot loop; `to_string()`/`to_owned()` where a borrow works | `rust-performance` |
| **PER-002** | MEDIUM | `Vec::new()` + push loop where the size is known (`with_capacity`) | `rust-performance` |
| **PER-003** | MEDIUM | N+1 queries / repeated work in a loop | `rust-performance` |
| **API-001** | MEDIUM | Function > ~50 lines or nesting > 4 levels | `refactoring`, `rust-idioms` |
| **API-002** | MEDIUM | Wildcard `_ =>` on a business enum (hides new variants) | `rust-idioms` |
| **API-003** | MEDIUM | `pub` item without a `///` doc | `rust-idioms` |
| **API-004** | MEDIUM | `#[allow(...)]` suppressing a lint without a justifying comment | `rust-idioms` |
| **API-005** | MEDIUM | Crate-root `#![deny(warnings)]` / blanket lint-level attributes (brittle) | `rust-idioms` |
| **API-006** | MEDIUM | Public-API guideline break (missing common-trait impls, `Deref`-as-inheritance, out-params, unsealed extensible trait, leaked unstable dep, absent `CHANGELOG`/metadata) — see `api-design.md` | per `api-design.md` |
| **MNT-001** | MEDIUM¹ | Missed code judo — a reframing would make the change dramatically simpler or delete a category of complexity | `refactoring` |
| **MNT-002** | MEDIUM¹ | File-size growth past ~700 lines — decomposition smell; split by responsibility | `refactoring` |
| **MNT-003** | MEDIUM¹ | Spaghetti branching — ad-hoc conditional spliced into a shared flow instead of behind a dedicated abstraction | `refactoring` |
| **MNT-004** | MEDIUM¹ | Needless optionality / casts — superfluous `Option`, `as`-casts where `From`/`TryFrom` belongs, `Box<dyn Any>` downcasting | `rust-idioms` |
| **TST-001** | HIGH | New error path or branch with no test | `rust-testing` |
| **TST-002** | HIGH | Bug fix landed without a regression test reproducing it | `rust-testing` |
| **TST-003** | MEDIUM | Weak assertion — test passes whether or not the behavior holds (no `.never()`, asserts nothing meaningful) | `rust-testing` |
| **DEP-001** | MEDIUM | API used incorrectly **for the crate version actually pinned** (deprecated/removed/changed since) — see the dependency-context step in `SKILL.md` | `rust-ecosystem` |
| **DEP-002** | HIGH | Known-vulnerable dependency version (RUSTSEC advisory) | `rust-security` |

¹ `MNT-*` are MEDIUM by default; in **strict mode** they become a presumption of block unless the
author justified the change in the diff or brief (see `SKILL.md` → Maintainability bar).

## Adding a rule

Append a new ID under the right prefix (next free number); never renumber existing rows. Keep the
row in sync with the `SKILL.md` checklist prose. Prefixes: `SAF` safety · `ERR` error handling ·
`OWN` ownership · `CON` concurrency · `PER` performance · `API` api/quality · `MNT` maintainability ·
`TST` tests · `DEP` dependencies.
