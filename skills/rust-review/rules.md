# Rust review — rule catalog

Stable IDs for the severity checklist in `SKILL.md`. A finding that maps to a rule **cites its ID**
(e.g. `CON-003`) so it is addressable, dedup-able across rounds, and greppable in a report. IDs are
append-only: never renumber or reuse a retired ID.

This catalog **mirrors** the `SKILL.md` checklist — the checklist is the prose, this is the index.
Severities match; `strict` mode escalates the `MNT-*` rules to a presumption of block.

The severity column is the rule's **default**, not a licence: the harm cap of the `review-rules`
skill (`severity.md`) bounds every finding by the harm it names, and a finding is never rated above
that cap whatever its row says. Finding classes, the sibling sweep and the other search moves are
there too; this catalog keeps only what is specific to Rust. Not every
finding maps to a catalog rule (novel issues are fine and encouraged — report them without an ID).

| ID | Severity | Rule | Fix skill |
|---|---|---|---|
| **SAF-001** | CRITICAL | `unwrap`/`expect`/`panic!`/`todo!`/`unreachable!` on a reachable production path | `rust-errors`, `rust-idioms` |
| **SAF-002** | CRITICAL | `unsafe` block without a `// SAFETY:` comment justifying every invariant | `rust-unsafe` |
| **SAF-003** | CRITICAL | SQL/command built by string interpolation of untrusted input (injection) | `rust-security` |
| **SAF-004** | CRITICAL | User-controlled path used without canonicalize + prefix check (traversal) | `rust-security` |
| **SAF-005** | CRITICAL | Hardcoded secret / key / token / password in source | `rust-security` |
| **SAF-006** | CRITICAL | Deserializing untrusted input without size/depth limits | `rust-security` |
| **SAF-007** | HIGH | Untrusted-input arithmetic whose outcome **diverges between build profiles** — a dev/test `overflow-checks` panic that wraps silently in release. Grade against the shipping profile and report what release does *instead* | `rust-errors`, `rust-security` |
| **SAF-008** | CRITICAL | `debug_assert!` as the only guard on an `unsafe` precondition or other load-bearing invariant — it compiles out in release, so the shipped binary runs unguarded | `rust-unsafe`, `rust-performance` |
| **SAF-009** | HIGH | Algorithmic-complexity blow-up reachable from untrusted input — superlinear work, unbounded recursion, or a rebuild whose cost is decoupled from output size. Severity must be **measured**, not inherited from a similar bug (see `SKILL.md` → Severity magnitude) | `rust-performance`, `rust-security` |
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
| **PER-001** | LOW⁴ | Allocation inside a hot loop; `to_string()`/`to_owned()`/`format!`/`clone()` inside a loop where the value could be borrowed or built once (a clone only to satisfy the borrow checker is OWN-001) | `rust-performance` |
| **PER-002** | LOW⁴ | `Vec::new()` + push loop where the size is known (`with_capacity`) | `rust-performance` |
| **PER-003** | LOW⁵ | N+1 queries / repeated work in a loop | `rust-performance` |
| **PER-004** | LOW⁴ | `collect()` into a `Vec` only to iterate it once, take its `len()` or call `contains` — iterate the iterator, `.count()`, `.any()`; not when the collect ends a borrow before a mutation, the `Vec` is read twice, or its `len` is taken and then it is iterated | `rust-performance` |
| **PER-005** | LOW⁴ | Returns an owned `Vec`/`String` its callers only iterate or read, where `impl Iterator<Item = …>` or a borrow (`&str`, `&[T]`) would do — weighing that `impl Iterator` cannot be returned from a dyn-compatible trait method, needs `+ '_` before edition 2024, and takes `len`/indexing/reuse from callers; not on a `pub` item of a library crate that already exists on the base (a signature change to a released item: the compat lens) — a `pub` item the diff adds is unreleased and in scope | `rust-performance` |
| **PER-006** | LOW⁴ | Parameter typed `&[String]` or another borrowed collection of owned strings (`&[Vec<String>]`), forcing callers that hold `&str`s to allocate, where `&[&str]` or `impl IntoIterator<Item = impl AsRef<str>>` serves them; a `&String`/`&Vec<T>` parameter is clippy `ptr_arg` and an owned `String` parameter OWN-002; not on a `pub` item of a library crate that already exists on the base (a signature change to a released item: the compat lens) — a `pub` item the diff adds is unreleased and in scope | `rust-performance`, `rust-ownership` |
| **PER-007** | LOW⁴ | Lookup key built into a `String` (`format!`, `to_string`, concatenation) only for a `get`/`contains_key` — a `String` key takes a `&str` lookup; a `(String, String)` key cannot be looked up by `(&str, &str)` through `Borrow`: build the key once outside the loop, split into nested maps looked up by `&str`, or use `hashbrown`'s `Equivalent` | `rust-performance` |
| **API-001** | MEDIUM | Function > ~50 lines or nesting > 4 levels | `refactoring`, `rust-idioms` |
| **API-002** | MEDIUM | Wildcard `_ =>` on a business enum (hides new variants) | `rust-idioms` |
| **API-003** | LOW | `pub` item without a `///` doc | `rust-idioms` |
| **API-004** | LOW | `#[allow(...)]` suppressing a lint without a justifying comment | `rust-idioms` |
| **API-005** | LOW | Crate-root `#![deny(warnings)]` / blanket lint-level attributes (brittle) | `rust-idioms` |
| **API-006** | MEDIUM | Public-API guideline break (missing common-trait impls, `Deref`-as-inheritance, out-params, unsealed extensible trait, leaked unstable dep, absent `CHANGELOG`/metadata) — see `api-design.md` | per `api-design.md` |
| **MNT-001** | LOW¹ | Missed code judo — a reframing would make the change dramatically simpler or delete a category of complexity | `refactoring` |
| **MNT-002** | LOW¹ | File-size growth past ~700 lines — decomposition smell; split by responsibility | `refactoring` |
| **MNT-003** | LOW¹ | Spaghetti branching — ad-hoc conditional spliced into a shared flow instead of behind a dedicated abstraction | `refactoring` |
| **MNT-004** | LOW¹ | Needless optionality / casts — superfluous `Option`, `as`-casts where `From`/`TryFrom` belongs, `Box<dyn Any>` downcasting | `rust-idioms` |
| **INV-001** | HIGH | Operation accepts an entity in a transient/invalid lifecycle state (soft-delete / in-progress-mutation window) that the type's documented invariant forbids | `rust-architecture` |
| **INV-002** | HIGH | Scope-boundary crossing (tenant/project/network/address-range) leaves a scoped reference dangling — carried over without re-validating or re-deriving it against the new scope | `rust-architecture` |
| **INV-003** | MEDIUM | Raw value used where a documented derived/`effective_*` quantity is required | `rust-architecture` |
| **INV-004** | HIGH | One field mutated/scrubbed but a sibling field the same invariant governs left stale/inconsistent | `rust-architecture` |
| **INV-005** | HIGH | Enforcement asymmetry — an invariant guarded at one site but not at its mirror (client↔server, send↔receive, offered↔accepted, one-param↔all-params). The asymmetry is the finding; no crash required. A guard present in the last released tag and gone at HEAD is a regression — say so | `rust-architecture`, `rust-web` |
| **REC-001** | HIGH | create and update/apply paths diverge on desired state (fields/metadata dropped on one arm) | `distributed-races` (R7) |
| **REC-002** | HIGH | progress / observed-generation / Ready recorded despite a secondary step that can fail — partial failure strands state | `distributed-races` (R8) |
| **REC-003** | HIGH | child/external resource created with no cleanup on delete/disable (missing owner-reference or finalizer) | `distributed-races` (R9) |
| **REC-004** | MEDIUM | status/condition never cleared when its subject is gone, or written unconditionally (no `desired != current` guard) | `distributed-races` (R10) |
| **REC-005** | MEDIUM | disabled feature still issues API calls, or its error aborts the primary reconcile | `distributed-races` (R11) |
| **REC-006** | MEDIUM | non-idempotent apply — create/patch off a stale read, no 404/409 race tolerance | `distributed-races` (R12) |
| **TST-001** | LOW² | New error path or branch with no test | `rust-testing` |
| **TST-002** | LOW² | Bug fix landed without a regression test reproducing it | `rust-testing` |
| **TST-003** | LOW² | Vacuous test — passes whatever the code does (`assert!(true)`, no assertions, no `.never()`): counts as a missing test | `rust-testing` |
| **TST-004** | ≤ MEDIUM³ | Weak assertion — a test that still passes under a named regression of the changed behaviour (asserts only a status or annotation, a mock ignores the input or fabricates the response, one side of two covered) | `rust-testing` |
| **DEP-001** | MEDIUM | API used incorrectly **for the crate version actually pinned** (deprecated/removed/changed since) — see the dependency-context step in `SKILL.md` | `rust-ecosystem` |
| **DEP-002** | HIGH | Known-vulnerable dependency version (RUSTSEC advisory) | `rust-security` |

¹ `MNT-*` are LOW by default (maintainability is optional under the harm cap); in **strict mode**
they are reported at MEDIUM and become a presumption of block unless the author justified the
change in the diff or brief (see `SKILL.md` → Maintainability bar).

² `TST-001`–`TST-003` are LOW by default. A missing or vacuous test takes the severity of the
defect it would catch, once that defect and its harm are named (`review-rules` `severity.md`) — a
missing cross-tenant denial test on a new authz-guarded endpoint names a security harm and is HIGH.

³ `TST-004` names the regression it lets through and the production line it breaks, and takes
that regression's harm, capped at MEDIUM; a text- or style-only regression leaves it LOW, and one
that names no regression is not a weak assertion.

⁴ `PER-001`, `PER-002` and `PER-004`–`PER-007` are LOW, held to the harm caps (`review-rules` `severity.md`):
a performance cost names no harm above `none`. Whether the site is on a hot path — a loop, a request
handler, a function called per item or per request — is said in the finding as information, not as
a raise. No finding: a one-off allocation at start-up, in a test, in a CLI's argument handling or on
an error path; a clone the borrow checker genuinely needs (shared ownership across threads or
tasks, a value moved into a closure). Instances of one of these patterns are rolled into ONE
finding, cited at its first site, whose `why` lists every site as `file:line` so a re-review can
check each. The roll-up is for these LOW needless-allocation findings only: it does not override
the sibling sweep (`review-rules` `sweeps.md` §1) for defects.

⁵ `PER-003` is LOW unless the finding names a harm above `none`: N+1 queries or repeated calls
against a database or the network that, at the load the code meets, stall a request path or a
controller until an operator steps in fill `operator-recovery` and are MEDIUM, the finding naming
that load and who recovers; one that names no such harm stays LOW.

## Adding a rule

Append a new ID under the right prefix (next free number); never renumber existing rows. Keep the
row in sync with the `SKILL.md` checklist prose. Prefixes: `SAF` safety · `ERR` error handling ·
`OWN` ownership · `CON` concurrency · `PER` performance · `API` api/quality · `MNT` maintainability ·
`INV` domain invariants & lifecycle · `REC` reconciler / eventual-consistency · `TST` tests · `DEP` dependencies.
