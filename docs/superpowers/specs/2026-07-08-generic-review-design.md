# Generic multi-language review engine — design

**Date:** 2026-07-08
**Status:** Approved, ready for implementation plan
**Supersedes the language coupling of:** [Elastic deep review engine](2026-06-23-elastic-deep-review-design.md)
— that engine stays; this extracts its Rust-specific parts into a pluggable profile so the same
engine can review other languages (Nix first).

## Problem

The review engine (`workflows/rust-review.js`) is elastic and language-agnostic in its *control
flow* — scout → lens fan-out → loop-until-dry → adversarial verify → completeness critic →
synthesis → verdict → run record, plus the security-sensitive rigor floor, the negative-space lens,
and INCOMPLETE tracking. But everything a *language* contributes is hard-wired to Rust: the cargo
gate, the lens briefs (`unwrap`, `Send/Sync`, clippy), the rule catalog (`rules.md`), the diff glob
(`'*.rs'`), the dependency-context step (`cargo metadata`), and the `craft:rust-reviewer` worker.
craft is going multi-language (Nix now, per `plugin.json` "Multi-language over time"), so the engine
must become generic with the language parts pluggable — without regressing the working Rust path.

## Constraint that shapes the design

Workflow scripts run in a **sandbox with no module resolution** — no `require`/`import` of local
files. This is documented in-repo: all four workflows carry `// … VERBATIM mirror of
lib/run-record.mjs — the sandbox can't import; keep in sync`. Therefore the engine and the language
registry **cannot** be split into `lib/review-engine.js` + `languages/*.js` imported by thin
wrappers. The registry must live **inline** in one self-contained script.

## Decisions (from brainstorming)

1. **Language-profile registry, inline.** One self-contained `workflows/review.js` holds the engine
   plus an inline `PROFILES = { rust, nix }` object literal. Each profile is a plain object
   implementing the profile contract (below). Rust becomes one profile; nothing about the engine's
   behavior changes for a Rust diff.
2. **Auto-detect, one merged report.** The engine detects every language present in the diff and
   runs each active profile's gate + lenses on that profile's files, merging into one verdict/report/
   run record. A mixed `.rs` + `.nix` diff is reviewed in a single run. An explicit
   `args.languages` list pins the run to those profiles.
3. **Thin pins + repointed audit.** `workflows/rust-review.js` and `workflows/nix-review.js` become
   ~5-line pins: `await workflow('review', { languages: ['<lang>'], ...args })`, kept for explicit
   single-language runs and reference compatibility. `workflows/rust-audit.js` is repointed from
   `workflow('rust-review', …)` to `workflow('review', { languages: ['rust'], … })` so it never
   nests two levels (`workflow()` nesting is one level only).
4. **One engine, no duplication.** The engine exists once, in `review.js`. The only hand-mirror is
   the pre-existing `run-record` helper block, unchanged.
5. **Per-language standalone reviewer agents.** The engine's lens/verify workers use
   `profile.reviewerAgent`. Rust keeps `craft:rust-reviewer` (also the ad-hoc standalone agent). Nix
   gets a parallel `craft:nix-reviewer` that loads the `nix-review` rubric.

## Architecture

### Profile contract

Each entry in `PROFILES` is an object:

| Field | Type | Purpose |
|---|---|---|
| `id` | string | `'rust'`, `'nix'` |
| `detect(files)` | `(string[]) => boolean` | true if the changed-file set belongs to this language |
| `diffGlobs` | `string[]` | git pathspecs scoping the diff (e.g. `["'*.rs'"]`, `["'*.nix'"]`) |
| `lenses` | `string[]` | the lens menu the scout picks from for this language |
| `lensBrief` | `Record<lens,string>` | per-lens brief text (the old `LENS_BRIEF`, per language) |
| `rubricSkill` | string | skill the lens worker loads (`'rust-review'` / `'nix-review'`) |
| `ruleCatalog` | string | path to the rules.md the worker cites `ruleId` from |
| `reviewerAgent` | string | agentType for lens/verify workers |
| `gate(ctx)` | `(ctx) => string` | mechanical-gate + tool-seed prompt (cargo… vs nix…) |
| `depContext(ctx)` | `(ctx) => string` | dependency-context step (cargo metadata vs flake.lock/inputs) |
| `securityHints` | string | optional: what makes this language security-sensitive |

`ctx` carries `{ baseRef, diffGlobs, isLibrary }`.

### Engine (language-agnostic, owns all control flow)

Unchanged in spirit from the elastic engine; the only structural change is that lens tasks and the
gate iterate over **active profiles**:

- **Detect:** `git diff --name-only <base>` → run each `profile.detect` → `active = matched
  profiles`; intersect with `args.languages` when provided. Empty → emit a "no supported language"
  report and return.
- **Scout:** diff-wide (size bucket, `securitySensitive`) as today; the lens *menu* is taken per
  profile (`profile.lenses`). The security floor, verifyVotes, maxRounds, completeness-critic gate
  are unchanged.
- **Gate:** run each active profile's `gate(ctx)` agent; merge `status` (worst), `provenance`
  (joined), `failedChecks`, `seedFindings`.
- **Lens fan-out:** tasks = for each active profile, for each planned lens in `profile.lenses` →
  one worker, tagged with `profile.id` so it uses that profile's `lensBrief`, `rubricSkill`,
  `ruleCatalog`, `reviewerAgent`, and `diffGlobs`. Loop-until-dry, dedup, verify, critic — as today,
  keyed within profile where relevant.
- **Negative-space lens:** per profile, using that profile's `diffGlobs` and hints.
- **Synthesis / verdict / record:** one report; verdict = worst across all confirmed findings;
  dimensions tally becomes `profile:lens`; run record carries the active-language set.

All cross-cutting mechanisms — securitySensitive rigor floor, negative-space, INCOMPLETE/`notRun`
(budget-skips + dropped lenses), `ruleId`, budget gating — are engine-level and apply across the
merged set unchanged.

### File layout

- `workflows/review.js` — engine + inline `PROFILES { rust, nix }` + auto-detect. The workflow.
- `workflows/rust-review.js` — thin pin `languages: ['rust']`.
- `workflows/nix-review.js` — thin pin `languages: ['nix']`.
- `workflows/rust-audit.js` — repointed to `workflow('review', { languages: ['rust'], … })`.
- `agents/nix-reviewer.md` — standalone Nix reviewer (parallels `rust-reviewer`).

## Nix profile

- **detect:** any `*.nix`, or `flake.nix` / `flake.lock`.
- **gate:** `nix flake check` (when a flake); formatter check (`alejandra --check` or `nixpkgs-fmt
  --check`, whichever the repo uses); `statix check`; `deadnix`; `nix build` / `nix eval` for eval
  errors. statix/deadnix diagnostics become seed findings (never gate failures).
- **lenses:** `purity` (impure builtins, unpinned fetchers without hash) · `reproducibility`
  (unpinned inputs, missing `flake.lock`, import-from-derivation, `--impure` reliance) · `injection`
  (untrusted interpolation into build scripts) · `packaging` (`mkDerivation` correctness: hashes,
  builder choice, `meta`/license, phases) · `dev-env` (devShell/direnv, the `allowUnfree`-doesn't-
  propagate-to-`nix develop` gotcha) · `modules` (nixos/home-manager option typing, cross-platform
  Linux+Darwin, secrets kept out of the store) · `maintainability` · `intent`.
- **rubricSkill:** `nix-review`. **ruleCatalog:** `skills/nix-review/rules.md` with ID prefixes
  `PUR/REP/INJ/PKG/DEV/MOD/MNT/DEP`. **reviewerAgent:** `craft:nix-reviewer`.
- **depContext:** resolve flake inputs / `flake.lock` pins; flag unpinned or channel-based inputs;
  RUSTSEC has no Nix analogue — DEP rules cover pinning, not CVEs.

## Nix skills (domain knowledge → rubric)

New skills under craft conventions (SKILL.md + sub-files), structure modeled on YPares/agent-skills
(MIT), gotchas distilled from Skillkit / aculich (idea sources, original prose):

- `nix-flakes` — inputs/outputs, `flake.lock` pinning, devShells/packages/nixosConfigurations,
  flake-parts/flake-utils, the `allowUnfree` propagation gotcha.
- `nix-packaging` — `mkDerivation`, language builders (`buildRustPackage`/`buildGoModule`/
  `buildPythonPackage`/npm), `vendorHash`/`cargoHash`, `fetchFromGitHub`, `meta`, iterative
  `nix-build`.
- `nix-dev-env` — devShells + direnv, `writeShellApplication`, formatters, statix/deadnix,
  pre-commit.
- `nixos` (+ `home-manager.md`) — declarative modules, cross-platform Linux+Darwin, secrets
  (agenix/sops-nix), hardening.
- `nix-review` — the review rubric + `rules.md` (part of the engine's Nix profile).

Registered in `MAP.md` (new language section) and `plugin.json`. `CLAUDE.md` default review becomes
`review` (auto-detects language); `rust-review` / `nix-review` documented as explicit pins.

## Testing / regression

The dominant risk is regressing the working Rust review during extraction. Mitigation:

1. Step 2 (extract) is a **mechanical move**: the Rust gate/lens-briefs/rules/dep-context strings are
   relocated into `PROFILES.rust` **verbatim** — no prompt-text changes. Verify `node --check`, and
   diff the relocated strings against the current file to confirm none changed.
2. Behavior check: run pinned-Rust `review` on the vodopad PR-1171 base (the branch already used as
   the reference case) and confirm it reproduces the current `rust-review` finding set and verdict
   shape.
3. Nix is added only after the Rust path is confirmed identical.

## Implementation order

1. Nix skills + `nix-review` rubric/`rules.md` (knowledge first — it feeds the profile).
2. Extract engine: `review.js` = engine + `PROFILES.rust`, behavior-identical; `rust-review.js` →
   thin pin; repoint `rust-audit.js`. Regression-check per above.
3. Add `PROFILES.nix` + `craft:nix-reviewer` agent + auto-detect + multi-language merge.
4. Docs: `CLAUDE.md` / `README.md` / `MAP.md` / `plugin.json`.

## Non-goals

- No cross-language finding correlation (a Rust finding never references a Nix line).
- No new shared `lib/` module for the engine (sandbox forbids importing it).
- No router/dispatcher skill — flat description-triggering + `Boundaries` cross-links remain the
  routing model; a router is reconsidered only if one language's skill set grows dense.
