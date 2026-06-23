# Cutting Rust Compile Times Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "cutting compile times / fast iteration" sub-file to the `rust-performance` skill, the counterpart to the existing runtime-optimization guidance.

**Architecture:** One new sub-file `skills/rust-performance/compile-times.md` holding the fast-iteration toolkit, plus wiring in `skills/rust-performance/SKILL.md` (a When-to-Use bullet, a short "other axis" section linking the sub-file, and `description`/triggers updates). Skill-content only — no agent, workflow, or code behavior changes.

**Tech Stack:** Markdown skill files in the craft plugin layout (`skills/<name>/SKILL.md` + sub-files). Cross-references use `[label](file.md)` for same-skill files and bare skill names (e.g. `rust-ecosystem`) for sibling skills.

## Global Constraints

- Skill-content only: do NOT touch any file under `agents/` or `workflows/`, and do not change review behavior. (Spec: "not review-relevant".)
- This is the *iteration-speed* axis; the *runtime-speed* axis stays in `optimizing.md`. Where the same knob (`codegen-units`, `lto`, `opt-level`) appears in both, state that its effect is opposite and cross-reference `optimizing.md`. (Spec §Problem, §Non-goals.)
- Capture the generalizable lever (crate granularity → parallelism + incrementality); do NOT recommend auto-generating hundreds of crates. (Spec §Source, §Non-goals.)
- Match the existing skill voice: measure-first, tables/code-with-inline-comment-tradeoffs, a closing `## Boundaries` section. (Observed in `SKILL.md` / `optimizing.md`.)
- No test runner exists for docs. A step's verification is `rg -n "<exact phrase>" <file>` to confirm content landed; all TOML/Rust snippets must be valid as written; cross-reference links must point at real files/skills.
- Commit after each task. Commit messages authored as the user — NO Claude/Claude Code attribution, no `Co-Authored-By` trailer.

---

### Task 1: Create the `compile-times.md` sub-file

**Files:**
- Create: `skills/rust-performance/compile-times.md`

**Interfaces:**
- Consumes: nothing (new file).
- Produces: a sub-file that Task 2's `SKILL.md` link (`[compile-times.md](compile-times.md)`) will point to. Internal cross-links it relies on existing: `optimizing.md` (same dir), skills `rust-ecosystem` and `rust-traits` (both exist under `skills/`).

- [ ] **Step 1: Create the file with the full toolkit content**

Write `skills/rust-performance/compile-times.md` verbatim:

````markdown
# Cutting compile times

The counterpart to [optimizing.md](optimizing.md). That file tunes the build to make the **binary
faster at runtime**; this one tunes it to make the **edit→compile→run loop faster**. The two axes
pull in opposite directions on several knobs — `codegen-units`, `lto`, `opt-level` — so keep the
axis you're on explicit. Same measure-first ethos: profile the build before tuning it.

## Measure first — where the time goes

- `cargo build --timings` — writes an HTML report under `target/cargo-timings/` showing each
  crate's compile time and the critical path. Read it before changing anything; the bottleneck is
  usually a handful of crates, not "Rust is slow".
- `cargo llvm-lines` — ranks functions by how much LLVM IR they generate; the top of the list is
  your monomorphization bloat (generic functions instantiated many times).
- `cargo +nightly rustc -- -Z self-profile` — deeper per-pass rustc profiling when `--timings`
  isn't enough.

## Faster linker — the cheapest big win

Linking is serial and often dominates incremental builds (you relink on every change). Switching
linkers needs no source changes:

```toml
# .cargo/config.toml
[target.x86_64-unknown-linux-gnu]
linker = "clang"
rustflags = ["-C", "link-arg=-fuse-ld=mold"]   # mold: fastest on Linux (install: apt / brew `mold`)
```

- **Linux:** `mold` is fastest; `lld` is a solid second.
- **macOS:** recent Xcode toolchains ship a fast default linker, so the old advice to bolt on
  `zld`/`lld` is mostly obsolete — measure before adding one.
- **Cross-platform fallback:** `lld` via `rustflags = ["-C", "link-arg=-fuse-ld=lld"]`.

## Dev profile tuning

The dev profile drives your inner loop. Tune it for rebuild speed:

```toml
# Cargo.toml
[profile.dev]
opt-level = 0                 # default; raise to 1 only if the dev loop is itself CPU-bound
debug = "line-tables-only"    # enough for backtraces, far less debuginfo to emit
split-debuginfo = "unpacked"  # macOS: keeps debuginfo out of the link step
incremental = true            # the dev default — keep it; recompiles only changed units

[profile.dev.package."*"]
opt-level = 2                 # optimize dependencies once; your own crate stays cheap to rebuild
```

When the loop only needs a type-check (not a run), `cargo check` skips codegen and is several
times faster than `cargo build`.

## `codegen-units` — calibration

A common reflex is to raise `codegen-units` "for parallelism". For **compile speed** this rarely
helps: the dev default is already 256, which saturates parallelism, and pushing higher buys
nothing. The levers that actually move compile time are the linker and crate granularity, not this
knob.

The opposite move — `codegen-units = 1` — is a **runtime** optimization (see
[optimizing.md](optimizing.md)): it lets the optimizer see a whole crate at once and **costs**
compile time. Set it on `[profile.release]` for the shipped binary, never on the dev loop.

## Crate splitting — parallelism and incrementality

`rustc` parallelizes at *crate* granularity and the incremental cache is per crate. A single giant
crate therefore serializes compilation and forces a full recompile on any change. Splitting a
monolith into a workspace of focused crates lets cores work in parallel and confines a rebuild to
the crate you touched (and its dependents).

- Split along seams you already have — a library core, separate adapters, a thin binary. Workspace
  layout and dependency-weight tradeoffs live in `rust-ecosystem`.
- **Caveat:** each crate boundary adds (de)serialization + linking cost, so over-splitting *raises*
  total time. Split where there's a real dependency seam; don't chase a thousand crates. (The
  widely-cited result behind this lever came from machine-generated code with hundreds of
  independent operators — a niche the lever generalizes from, not a target to copy.)

## Monomorphization is a compile-time cost

Every generic function is recompiled for each concrete type it's instantiated with. Heavy generics
and deep generic call trees multiply codegen and LLVM work — visible at the top of
`cargo llvm-lines`. To cut it:

- **Fewer instantiations:** prefer `&dyn Trait` at API boundaries that aren't hot — one compiled
  copy instead of N. The dispatch tradeoff (static vs `dyn` vs enum), including this compile-time
  dimension, is owned by `rust-traits`.
- **Thin generic shell, non-generic inner fn:** keep the generic surface tiny and forward to a
  single non-generic inner function, so only the small shell is monomorphized:

```rust
pub fn load<P: AsRef<Path>>(path: P) -> io::Result<Vec<u8>> {
    fn inner(path: &Path) -> io::Result<Vec<u8>> {
        // the real work — compiled once, not per P
        std::fs::read(path)
    }
    inner(path.as_ref())
}
```

Honest tradeoff: `dyn` adds an indirect call, and the inner-fn split is a touch more code — you
trade a little runtime for compile speed. Worth it on cold paths; measure on hot ones.

## Caching

- **`sccache`** caches compiled artifacts across builds and machines — most valuable in CI and when
  switching branches. Set `RUSTC_WRAPPER=sccache` (env or `.cargo/config.toml`).
- Trust the incremental cache; **don't `cargo clean` reflexively** — it throws away exactly the
  work you're trying to save.

## Trim dependencies and features

Every dependency and every enabled feature is more code to compile. The compile graph shrinks when
you:

- Disable defaults you don't use:
  `foo = { version = "1", default-features = false, features = [...] }`.
- Audit what you actually pull in with `cargo tree` (and `cargo tree -e features` for feature
  edges). Dependency weight as a selection criterion lives in `rust-ecosystem`.

## Boundaries

- Tuning the build for a **faster runtime binary** (LTO, `codegen-units = 1`, `target-cpu`, PGO) →
  [optimizing.md](optimizing.md). This file is its counterpart; where a knob appears in both, the
  effect is opposite.
- Workspace structure, dependency selection, and feature design → `rust-ecosystem`.
- Static vs `dyn` vs enum dispatch (the runtime side of the monomorphization tradeoff) →
  `rust-traits`.
````

- [ ] **Step 2: Verify the key sections and the two-axes framing landed**

Run:
```bash
rg -n "edit→compile→run loop faster|cargo build --timings|fuse-ld=mold|codegen-units. — calibration|Crate splitting|Monomorphization is a compile-time cost|don't .cargo clean. reflexively" skills/rust-performance/compile-times.md
```
Expected: matches for the intro two-axes line, the diagnostics command, the linker rustflag, and the four section headers.

- [ ] **Step 3: Verify cross-reference targets exist**

Run:
```bash
ls skills/rust-performance/optimizing.md skills/rust-ecosystem/SKILL.md skills/rust-traits/SKILL.md
```
Expected: all three paths listed (no "No such file"). Confirms `optimizing.md`, `rust-ecosystem`, and `rust-traits` links resolve.

- [ ] **Step 4: Sanity-check the embedded snippets**

Read `skills/rust-performance/compile-times.md` and confirm: the `.cargo/config.toml` and `Cargo.toml` blocks are valid TOML (table headers in brackets, string values quoted, `rustflags` is an array), and the Rust `load`/`inner` snippet compiles in principle (returns `io::Result<Vec<u8>>` from both the inner body and the outer call). No tool run needed — visual check.

- [ ] **Step 5: Commit**

```bash
git add skills/rust-performance/compile-times.md
git commit -m "docs(rust-performance): add compile-times sub-file (fast-iteration toolkit)"
```

---

### Task 2: Wire `compile-times.md` into `SKILL.md`

**Files:**
- Modify: `skills/rust-performance/SKILL.md` (the `description` frontmatter line; the `## When to Use` list; a new short section after "Free wins — build configuration")

**Interfaces:**
- Consumes: `skills/rust-performance/compile-times.md` from Task 1 (the link target).
- Produces: nothing downstream depends on it.

- [ ] **Step 1: Add the iteration-speed trigger to the `description` frontmatter**

In `skills/rust-performance/SKILL.md`, replace the end of the `description:` line. Find:

```
or tuning build settings. Triggers: criterion, divan, flamegraph, bumpalo, FxHashMap, LTO, codegen-units, target-cpu, PGO, SIMD, jemalloc, mimalloc, dhat, BufWriter, swap_remove.
```

Replace with:

```
or tuning build settings, or when builds are slow and you want to cut compile times / speed up the edit-compile-run loop. Triggers: criterion, divan, flamegraph, bumpalo, FxHashMap, LTO, codegen-units, target-cpu, PGO, SIMD, jemalloc, mimalloc, dhat, BufWriter, swap_remove, compile times, slow build, mold, lld, sccache, cargo --timings, cargo llvm-lines, incremental.
```

- [ ] **Step 2: Add a When-to-Use bullet**

Find the `## When to Use` list ending with:

```
- Tuning build/compile settings for speed or size
```

Replace that line with:

```
- Tuning build/compile settings for speed or size
- The edit→compile→run loop is too slow — cutting compile times ([compile-times.md](compile-times.md))
```

- [ ] **Step 3: Add the "other axis" section linking the sub-file**

Find the end of the "Free wins — build configuration" section (the `.cargo/config.toml` block ending):

```
[build]
rustflags = ["-C", "target-cpu=native"]
```

Immediately after that closing code fence, insert a new section:

```markdown

## The other axis — faster builds, not faster binaries

Everything above tunes the build for a **faster runtime binary**, at the cost of compile time
(`lto`, `codegen-units = 1`). The opposite goal — a **faster edit→compile→run loop** — is its own
toolkit: switch to a fast linker (`mold`/`lld`), tune the dev profile, split a monolith crate so
`rustc` parallelizes and rebuilds incrementally, and cut monomorphization bloat. Several knobs flip
between the two axes, so keep them straight → [compile-times.md](compile-times.md).
```

- [ ] **Step 4: Verify the wiring landed**

Run:
```bash
rg -n "compile-times.md|The other axis|compile times, slow build, mold" skills/rust-performance/SKILL.md
```
Expected: matches for the When-to-Use bullet link, the new section header + its closing link, and the updated triggers line — at least four hits across three locations.

- [ ] **Step 5: Confirm no agent/workflow files were touched**

Run:
```bash
git status --porcelain
```
Expected: only `skills/rust-performance/SKILL.md` modified (Task 1's new file already committed). Nothing under `agents/` or `workflows/`.

- [ ] **Step 6: Commit**

```bash
git add skills/rust-performance/SKILL.md
git commit -m "docs(rust-performance): link compile-times sub-file + iteration-speed triggers"
```
