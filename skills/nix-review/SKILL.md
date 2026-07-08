---
name: nix-review
description: >-
  Nix code-review rubric — the flake quality gate (nix flake check, formatter --check, statix, deadnix, nix build/eval), a severity-tiered checklist (purity, reproducibility, injection, packaging, dev-env, modules, maintainability, dependencies), the Approve/Warning/Block verdict, and the Nix "what proves what" table. Use when reviewing Nix code or a diff, reviewing a flake, checking for impure derivations or IFD, or assessing whether a Nix change is mergeable. Triggers: nix review, review flake, statix, deadnix, nix flake check, impure derivation, IFD, review nix.
---

# Nix Review

The rubric for reviewing Nix changes: run the mechanical gate first, then read the diff against
the severity checklist, then issue a verdict. This is the knowledge; the `nix-reviewer` agent
applies it to an actual diff and reports back.

**The review entry point is the `nix-review` workflow** (`workflows/nix-review.js`): it
scout-scales depth to the diff, fans out the lenses below, grounds findings in tool output, and
adversarially verifies each one. This skill is the rubric the workflow and the `nix-reviewer`
lens worker apply.

## When to Use

- Reviewing a diff / PR of Nix code (flakes, packages, NixOS modules, dev shells)
- Deciding whether changes are safe to commit or merge
- A self-check before opening a PR

## Step 1 — Establish the gate (CI-aware)

The mechanical gate is non-negotiable: formatter `--check`, `statix check`, `deadnix`,
`nix flake check`, and `nix build` / `nix eval` must be green before human-style review is worth
doing. But **before running a check locally, ask whether CI already computed it on this PR; if a
conclusive required check covers it and is green, consume that result instead of recomputing.**

Establish each signal:

1. **Detect the PR's CI** for the current branch:
   ```bash
   gh pr checks --json name,state,bucket,link
   ```
   If `gh` is missing, unauthenticated, offline, or finds no PR → fall straight through to the
   local gate (never fail on detection).

2. **Formatter** — if a required check whose name matches (`alejandra`, `nixpkgs-fmt`, `fmt`,
   `format`) is conclusive:
   - green → **PASSED** (record provenance `via CI · PR #N`);
   - failed → gate red → **Block**;
   - absent/pending → run locally:
     ```bash
     alejandra --check .        # or: nixpkgs-fmt --check $(find . -name '*.nix')
     ```

3. **Linters** — if absent from CI, run locally:
   ```bash
   statix check
   deadnix --fail
   ```

4. **Flake check / build / eval** — if a required check matching `flake-check`, `nix build`, or
   `nix eval` is conclusive:
   - green → **PASSED**;
   - failed → gate red → **Block**;
   - absent/pending → run locally:
     ```bash
     nix flake check
     nix build                  # or: nix build .#<target>
     ```

If any signal is red (CI or local), stop and report — don't review further. A green gate is
the floor, not the ceiling.

## Step 1.5 — Resolve flake input context

Review against the input versions the project **actually locks**, not against nixpkgs-in-the-abstract.
An attribute available on `nixpkgs 24.05` may have been renamed or removed on the `23.11` this flake
locks. Before judging input usage:

- Read `flake.lock` to resolve the real revisions for inputs the diff touches.
- For any nontrivial input the diff exercises, check usage against that revision's API / option set.
  Version-specific misuse of a NixOS option or nixpkgs attribute is `DEP-001` (Medium).
- Known-stale or floating inputs are a separate axis, caught by `REP-001` in Step 2.

Best-effort: skip if there are no external-input changes.

## Step 2 — Severity checklist

Review the diff against these tiers. This skill owns only the review *process*; cite the owning
skill for each fix. Each item has a stable ID in the [rules.md](rules.md) catalog — cite it in a
finding (e.g. `INJ-001`) so the finding is addressable and dedup-able; novel issues without a
catalog ID are still welcome.

- Purity / reproducibility → `nix-packaging`, `nix-flakes`
- Command injection / untrusted interpolation → `nix-packaging`
- Packaging correctness (hashes, meta) → `nix-packaging`
- Dev-env config (`allowUnfree`, overlays) → `nix-dev-env`
- NixOS / HM modules (secrets, options) → `nixos`
- Maintainability (deadnix, statix, anti-idioms) → `nix-dev-env`
- Flake input management → `nix-flakes`

### CRITICAL — block on sight

**Security / injection**
- Untrusted value interpolated directly into a build phase or shell script without sanitization
  (`INJ-001`)

**Purity & secrets**
- Secret embedded as a plaintext string inside a derivation or store path instead of managed by
  agenix/sops-nix (`MOD-001`)

### HIGH — block unless justified

**Purity**
- Impure builtin used in a derivation (`builtins.currentTime`, `builtins.getEnv`,
  `<nixpkgs>` channel path) — breaks reproducibility (`PUR-001`)
- Fetcher missing a fixed output hash (`fetchgit`/`fetchurl` without `sha256`/`hash`) (`PUR-002`)

**Reproducibility**
- Flake input unpinned or channel-based (no `flake.lock` entry / `follows` missing) (`REP-001`)

**Packaging**
- Wrong or missing dependency hash (`cargoHash`/`vendorHash`/`npmDepsHash`) (`PKG-001`)

### MEDIUM — warn, may merge

**Reproducibility**
- Import-from-derivation (IFD) forcing eval-time builds, or `--impure` reliance (`REP-002`)

**Packaging**
- Missing `meta` (`description`/`license`/`mainProgram`) on a package (`PKG-002`)

**Dev-env**
- `allowUnfree`/config set in `flake.nix` but not propagated to `nix develop` (`DEV-001`)

**Modules**
- NixOS/HM option without a `type` or `default`; non-cross-platform assumption (`MOD-002`)

**Maintainability**
- Dead code (`deadnix`) / anti-idiom (`statix`) / needless `rec`/`with` (`MNT-001`)

**Dependencies**
- Flake input pin stale or floating where it should be locked (`DEP-001`)

## Review lenses

The workflow fans the rubric out into independent lenses, each reviewing ONE slice blind to the
others (higher recall than one broad pass):

| Lens | Slice | Owning skill for the fix |
|---|---|---|
| purity | impure builtins, missing hashes, channel paths | `nix-packaging` |
| reproducibility | IFD, unpinned inputs, `--impure` reliance | `nix-flakes` |
| injection | untrusted interpolation in build/shell scripts | `nix-packaging` |
| packaging | hash correctness, meta completeness | `nix-packaging` |
| dev-env | allowUnfree propagation, overlays, shell config | `nix-dev-env` |
| modules | NixOS/HM option types, defaults, secrets management | `nixos` |
| maintainability | deadnix, statix, needless rec/with, structural simplification | `nix-dev-env` |
| dependencies | stale/floating inputs, version-specific misuse | `nix-flakes` |
| intent | does the change do what the brief/spec says? | `specs` |

## Confidence tiers — surface, don't censor

- **Confirmed** — located and survived verification; drives the verdict.
- **Suspected** — borderline or unverified; surfaced for the author, **never** changes the verdict.

Report everything you suspect. Borderline findings go to Suspected, not the bin.

## Tool grounding (seed findings)

Beyond the gate, the workflow runs real tools scoped to the diff and feeds their output in as seed
findings (each still verified): `statix check` (anti-idioms), `deadnix --fail` (dead code),
`nix flake check --all-systems` (eval errors, cycle detection), and `nix build --dry-run`
(missing dependencies). Optional tools degrade gracefully when absent.

## Verification protocol

Every finding (lens or seed) is checked before it can be Confirmed:

- **Adversarial:** skeptics try to REFUTE it (default to refuted when uncertain). One skeptic by
  default; three-vote consensus for Critical/High.
- **Self-verification (anti-hallucination):** re-read the cited `file:line` — does the code
  actually say what the finding claims, and is the path reachable in a real build (not an
  example overlay or test derivation)? A wrong citation or unreachable path drops or demotes
  the finding.

## Step 3 — Verdict

| Verdict | When |
|---|---|
| **Approve** ✅ | gate green (CI or local), no **Confirmed** CRITICAL/HIGH/MEDIUM |
| **Warning** ⚠️ | gate green (CI or local), **Confirmed** MEDIUM only — Suspected items listed but don't block |
| **Block** ⛔ | gate red (CI or local), or any **Confirmed** CRITICAL/HIGH |

Report findings as `severity · file:line · [rule-id] · what · why · fix`. Cite the [rules.md](rules.md)
catalog ID when the finding maps to one (e.g. `PUR-001`); novel findings need no ID. Be specific
and cite the line; a finding without a location isn't actionable.

"Gate green / red" is read from Step 1 — the signal may come from a green required CI check or a
local run. Cite which in the `## Gate` line of the output.

## Proving a claim — what proves what

| Claim | Proof (run it) | Not proof |
|---|---|---|
| flake evaluates | `nix flake check` → exit 0 | "looks fine" |
| package builds | `nix build .#<pkg>` → exit 0 | eval passing |
| formatter clean | `alejandra --check .` / `nixpkgs-fmt --check` → exit 0 | "I ran fmt earlier" |
| no dead code | `deadnix --fail` → exit 0 | "looks unused" |
| no anti-idioms | `statix check` → exit 0 | code review alone |
| hash correct | `nix build` succeeds with hash present | hash field exists |
| input pinned | `flake.lock` entry present for input | `follows` set |
| no IFD | `nix flake check` without `--impure` → exit 0 | "shouldn't be IFD" |
| secret not in store | runtime secret management confirmed (agenix/sops-nix) | "looks encrypted" |
| bug fixed | re-run the case that reproduced it → passes | code changed |

A green **required CI check** for the same command is also valid proof of that command (see
Step 1 — Establish the gate). The point of the table is that *some* fresh authoritative signal
exists — CI or local — not that you must re-run it yourself.

## Boundaries

- *How* to package a derivation correctly → `nix-packaging` (this rubric only flags that it's wrong).
- *How* to manage flake inputs / lock files → `nix-flakes`.
- *How* to configure a dev shell → `nix-dev-env`.
- *How* to write NixOS/HM modules or manage secrets → `nixos`.
- This skill judges; it does not rewrite. Propose the fix, let the author apply it.
- The generic review/verify *discipline* → `superpowers:requesting-code-review`,
  `superpowers:receiving-code-review`, `superpowers:verification-before-completion`.
