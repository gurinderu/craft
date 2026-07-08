# Generic Multi-Language Review Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Rust-only `rust-review` workflow into a language-agnostic engine (`workflows/review.js`) with an inline profile registry, add a Nix profile + `nix-*` skills, so one review path auto-detects and reviews Rust and Nix (and future languages).

**Architecture:** One self-contained `workflows/review.js` holds the engine plus `PROFILES = { rust, nix }` (inline object literals — the sandbox cannot `import`). The engine detects languages present in the diff, runs each active profile's gate + lens set on that profile's files, and merges into one report/verdict/run-record. `rust-review.js` / `nix-review.js` are thin `workflow('review', {languages:[…]})` pins; `rust-audit.js` calls `review` directly to avoid two-level nesting.

**Tech Stack:** Node (workflow orchestrator scripts, sandboxed — no fs/imports), Markdown skills (SKILL.md + reference sub-files), the craft Workflow runtime globals (`agent`, `parallel`, `pipeline`, `workflow`, `budget`, `log`, `phase`).

## Global Constraints

- **Sandbox: no `require`/`import` in workflow scripts.** All shared code lives inline; the only hand-mirror is the existing `run-record` helper block (`// … VERBATIM mirror of lib/run-record.mjs`). Copy verbatim, keep in sync — do not attempt to import.
- **`workflow()` nesting is one level only.** A workflow invoked via `workflow()` must not itself call `workflow()`. Hence `rust-audit` calls `review` directly, and the `rust-review`/`nix-review` pins are only ever human/agent roots.
- **No unit-test harness for workflow orchestrators.** Validate JS with `node --check <file>`; validate behavior with a real `review` run on the reference diff. `lib/run-record.mjs` is the only unit-tested module and is NOT touched by this plan.
- **No Claude attribution** in commits (project rule).
- **Rust path must not regress.** Engine extraction (Phase 2) is a verbatim move of Rust-specific strings into `PROFILES.rust` — no prompt-text edits — verified by grep parity before Nix is added.
- **Skill file format:** `skills/<name>/SKILL.md` with YAML frontmatter (`name`, `description` containing a `Triggers:` clause) + optional reference `.md` sub-files. Register every new skill in `MAP.md` and the `plugin.json` description.
- **Rule catalog IDs are append-only.** Nix prefixes: `PUR REP INJ PKG DEV MOD MNT DEP`.

---

## Phase 1 — Nix domain skills (knowledge feeds the review rubric)

### Task 1: `nix-flakes` skill

**Files:**
- Create: `skills/nix-flakes/SKILL.md`
- Create: `skills/nix-flakes/anatomy.md`

**Interfaces:**
- Produces: skill `nix-flakes`, cross-referenced by `nix-packaging`, `nix-dev-env`, `nixos`, `nix-review`.

- [ ] **Step 1: Write `skills/nix-flakes/SKILL.md`.** Frontmatter exactly:

```markdown
---
name: nix-flakes
description: >-
  Nix flakes — the flake.nix inputs/outputs schema, pinning with flake.lock, the standard outputs (devShells, packages, nixosConfigurations, homeConfigurations), and structuring with flake-parts / flake-utils. Use when writing or debugging a flake, pinning or updating inputs, exposing dev shells or packages, or wiring a system config. Triggers: flake.nix, flake.lock, nix flake, inputs, outputs, devShell, flake-parts, flake-utils, nixpkgs input, follows.
---
```

Body must cover, concretely: the `{ inputs, outputs }` schema and `outputs = { self, nixpkgs, ... }:`; `inputs.<x>.follows` to dedupe nixpkgs; `flake.lock` as the pin (never hand-edit; `nix flake update`/`lock`); the standard output attrs per-system (`packages.<system>`, `devShells.<system>`, `nixosConfigurations`, `homeConfigurations`); `flake-utils.lib.eachDefaultSystem` vs `flake-parts` for multi-system; **the gotcha** that `nixpkgs.config.allowUnfree = true` set inside `flake.nix` does NOT propagate into `nix develop` (must import nixpkgs with config, or set `NIXPKGS_ALLOW_UNFREE`). Deep dive → `anatomy.md`. `## Boundaries`: derivations → `nix-packaging`; dev shells/direnv → `nix-dev-env`; system modules → `nixos`.

- [ ] **Step 2: Write `skills/nix-flakes/anatomy.md`** — a worked `flake.nix` (inputs with `follows`, `flake-parts` multi-system, a `devShells.default`, a `packages.default`), and the `nix flake` command surface (`check`, `show`, `update`, `lock`, `metadata`).

- [ ] **Step 3: Validate frontmatter.**

Run: `head -5 skills/nix-flakes/SKILL.md`
Expected: valid YAML frontmatter with `name: nix-flakes` and a `Triggers:` clause in `description`.

- [ ] **Step 4: Commit.**

```bash
git add skills/nix-flakes/
git commit -m "feat(nix): add nix-flakes skill"
```

### Task 2: `nix-packaging` skill

**Files:**
- Create: `skills/nix-packaging/SKILL.md`
- Create: `skills/nix-packaging/builders.md`

**Interfaces:**
- Produces: skill `nix-packaging`; consumed by `nix-review` (packaging lens rubric).

- [ ] **Step 1: Write `SKILL.md`.** Frontmatter `name: nix-packaging`, description covering derivations with `Triggers: mkDerivation, buildRustPackage, buildGoModule, buildPythonPackage, buildNpmPackage, vendorHash, cargoHash, fetchFromGitHub, meta, nix-build, derivation`. Body cardinal points: `stdenv.mkDerivation { pname; version; src; }` and the phase model (`unpackPhase`/`buildPhase`/`installPhase`); **fixed-output hashes** — `src` fetchers (`fetchFromGitHub`, `fetchzip`) need a `hash`/`sha256`, and language builders need a dependency hash (`cargoHash`/`vendorHash`/`npmDepsHash`); the iterative flow (set hash to `lib.fakeHash`, build, copy the "got:" hash back); `meta` (`description`, `license`, `mainProgram`) matters and is checked in review; never fetch impurely at build time. Details → `builders.md`.

- [ ] **Step 2: Write `builders.md`** — one minimal derivation per builder: `buildRustPackage` (`cargoHash`), `buildGoModule` (`vendorHash`), `buildPythonPackage`, `buildNpmPackage` (`npmDepsHash`), and a plain `mkDerivation` with explicit phases. Note the npm-from-source pattern adapted from YPares/agent-skills `package-npm-nix` (MIT — credit in commit).

- [ ] **Step 3: Validate.** Run: `head -5 skills/nix-packaging/SKILL.md` — Expected: valid frontmatter, `name: nix-packaging`.

- [ ] **Step 4: Commit.**

```bash
git add skills/nix-packaging/
git commit -m "feat(nix): add nix-packaging skill (derivations, builders)"
```

### Task 3: `nix-dev-env` skill

**Files:**
- Create: `skills/nix-dev-env/SKILL.md`

**Interfaces:**
- Produces: skill `nix-dev-env`; consumed by `nix-review` (dev-env lens).

- [ ] **Step 1: Write `SKILL.md`.** `name: nix-dev-env`, `Triggers: devShell, mkShell, direnv, .envrc, use flake, writeShellApplication, nixpkgs-fmt, alejandra, statix, deadnix, pre-commit`. Body: `pkgs.mkShell { packages = [...]; shellHook = ...; }` and exposing it as `devShells.default`; `direnv` + `.envrc` (`use flake`) for auto-entry; `writeShellApplication` for lint-checked script tools (over raw `writeScriptBin`); formatters (`alejandra` or `nixpkgs-fmt`) and linters (`statix check`, `deadnix`) as the Nix quality gate; wiring `pre-commit` via `pre-commit-hooks.nix`; repeat the `allowUnfree`→`nix develop` gotcha with the fix. `## Boundaries`: flake wiring → `nix-flakes`; the CI/review use of statix/deadnix → `nix-review`.

- [ ] **Step 2: Validate.** Run: `head -5 skills/nix-dev-env/SKILL.md` — Expected: valid frontmatter.

- [ ] **Step 3: Commit.**

```bash
git add skills/nix-dev-env/
git commit -m "feat(nix): add nix-dev-env skill (devShells, direnv, linters)"
```

### Task 4: `nixos` skill (+ home-manager)

**Files:**
- Create: `skills/nixos/SKILL.md`
- Create: `skills/nixos/home-manager.md`

**Interfaces:**
- Produces: skill `nixos`; consumed by `nix-review` (modules lens).

- [ ] **Step 1: Write `SKILL.md`.** `name: nixos`, `Triggers: nixosConfiguration, nixos module, options, config, home-manager, darwin, nix-darwin, agenix, sops-nix, systemd service`. Body: the module shape `{ config, lib, pkgs, ... }: { options; config; }`; declaring typed options (`lib.mkOption` + `types`); composing modules; `nixosConfigurations.<host> = nixpkgs.lib.nixosSystem { modules = [...]; }`; **secrets must never land in the world-readable Nix store** — use `agenix`/`sops-nix` (encrypted, decrypted at activation), never a plaintext string in a derivation; cross-platform via `nix-darwin` + Home Manager. Home Manager specifics → `home-manager.md`.

- [ ] **Step 2: Write `home-manager.md`** — standalone vs NixOS-module HM; a per-user config; cross-platform (Linux + Darwin) module structure; `home.packages`, `programs.<x>.enable`.

- [ ] **Step 3: Validate.** Run: `head -5 skills/nixos/SKILL.md` — Expected: valid frontmatter.

- [ ] **Step 4: Commit.**

```bash
git add skills/nixos/
git commit -m "feat(nix): add nixos skill (modules, home-manager, secrets)"
```

### Task 5: `nix-review` rubric skill + rule catalog

**Files:**
- Create: `skills/nix-review/SKILL.md`
- Create: `skills/nix-review/rules.md`

**Interfaces:**
- Produces: `rubricSkill='nix-review'` and `ruleCatalog='skills/nix-review/rules.md'`, consumed by `PROFILES.nix` (Task 11) and `craft:nix-reviewer` (Task 10). Rule IDs consumed by lens/verify finding output.

- [ ] **Step 1: Write `skills/nix-review/SKILL.md`** modeled on `skills/rust-review/SKILL.md` structure (gate → dependency context → severity checklist referencing `rules.md` → verdict), but Nix-flavored. `name: nix-review`, `Triggers: nix review, review flake, statix, deadnix, nix flake check, impure derivation, IFD, review nix`. Gate = `nix flake check`, formatter `--check`, `statix check`, `deadnix`, `nix build`/`nix eval`. Severity tiers map to the lenses in the spec. Cite `rules.md` IDs in findings.

- [ ] **Step 2: Write `skills/nix-review/rules.md`** as an ID table mirroring `skills/rust-review/rules.md` shape. Concrete rows (append-only IDs):

```markdown
| ID | Severity | Rule | Fix skill |
|---|---|---|---|
| **PUR-001** | HIGH | Impure builtin in a derivation (`builtins.currentTime`, `builtins.getEnv`, `<nixpkgs>` channel path) — breaks reproducibility | `nix-packaging` |
| **PUR-002** | HIGH | Fetcher without a fixed output hash (`fetchgit`/`fetchurl` missing `sha256`/`hash`) | `nix-packaging` |
| **REP-001** | HIGH | Flake input unpinned or channel-based (no `flake.lock` entry / `follows` missing) | `nix-flakes` |
| **REP-002** | MEDIUM | Import-from-derivation (IFD) forcing eval-time builds / `--impure` reliance | `nix-flakes` |
| **INJ-001** | CRITICAL | Untrusted value interpolated into a build/shell script (command injection) | `nix-packaging` |
| **PKG-001** | HIGH | Wrong or missing dependency hash (`cargoHash`/`vendorHash`/`npmDepsHash`) | `nix-packaging` |
| **PKG-002** | MEDIUM | Missing `meta` (`description`/`license`/`mainProgram`) on a package | `nix-packaging` |
| **DEV-001** | MEDIUM | `allowUnfree`/config set in `flake.nix` but not propagated to `nix develop` | `nix-dev-env` |
| **MOD-001** | HIGH | Secret embedded in the Nix store (plaintext in a derivation) instead of agenix/sops-nix | `nixos` |
| **MOD-002** | MEDIUM | NixOS/HM option without a type or default; non-cross-platform assumption | `nixos` |
| **MNT-001** | MEDIUM | Dead code (`deadnix`) / anti-idiom (`statix`) / needless `rec`/`with` | `nix-dev-env` |
| **DEP-001** | MEDIUM | Flake input pin stale or floating where it should be locked | `nix-flakes` |
```

Add the same append-only note and prefix legend as the Rust catalog.

- [ ] **Step 3: Validate.** Run: `head -5 skills/nix-review/SKILL.md && grep -c '^| \*\*' skills/nix-review/rules.md` — Expected: valid frontmatter; ≥12 rule rows.

- [ ] **Step 4: Commit.**

```bash
git add skills/nix-review/
git commit -m "feat(nix): add nix-review rubric skill and rule catalog"
```

### Task 6: Register Nix skills in MAP.md and plugin.json

**Files:**
- Modify: `MAP.md` (skills table — add a Nix section with 5 rows)
- Modify: `.claude-plugin/plugin.json` (description)

- [ ] **Step 1:** Add 5 rows to the `MAP.md` skills table (after the Rust rows), one per new skill, following the existing `| skill | ✅ | covers | boundaries |` format. Add a `### Nix` subheading if the table is sectioned; otherwise a comment row.

- [ ] **Step 2:** In `.claude-plugin/plugin.json`, extend the `description` skill list to mention Nix (e.g. append `; a Nix skill set (flakes, packaging, dev-env, nixos/home-manager, review)`).

- [ ] **Step 3: Validate.**

Run: `python3 -c "import json;json.load(open('.claude-plugin/plugin.json'));print('ok')" && grep -c 'nix-' MAP.md`
Expected: `ok`; ≥5 nix- mentions.

- [ ] **Step 4: Commit.**

```bash
git add MAP.md .claude-plugin/plugin.json
git commit -m "docs(nix): register nix skills in MAP and plugin manifest"
```

---

## Phase 2 — Extract the engine (Rust behavior identical)

### Task 7: Create `workflows/review.js` = engine + `PROFILES.rust`

**Files:**
- Create: `workflows/review.js` (from a copy of `workflows/rust-review.js`)
- Reference: `workflows/rust-review.js` (source of the verbatim strings)

**Interfaces:**
- Produces: workflow `review`, invoked as `workflow('review', { base?, path?, intent?, strict?, languages? , _via? })`. `languages` is an optional `string[]` restricting active profiles; absent = auto-detect (Task 12).
- Produces: `PROFILES` registry object; `PROFILES.rust` implements the profile contract:
  `{ id:'rust', detect(files), diffGlobs:["'*.rs'"], lenses, lensBrief, rubricSkill:'rust-review', ruleCatalog:'skills/rust-review/rules.md', reviewerAgent:'craft:rust-reviewer', gate(ctx), depContext(ctx), securityHints }`.

- [ ] **Step 1:** Copy the file: `cp workflows/rust-review.js workflows/review.js`. Change `meta.name` to `review` and `meta.description` to the generic wording ("Elastic deep review of a diff — auto-detects language(s), scout-scaled lens fan-out, …").

- [ ] **Step 2:** Introduce the `PROFILES` object literal near the top (after the schemas). Move the Rust-specific constructs into `PROFILES.rust` **without changing their text**:
  - `ALL_LENSES` array → `PROFILES.rust.lenses`.
  - `LENS_BRIEF` map → `PROFILES.rust.lensBrief`.
  - the generic body of `lensPrompt` (the Rust rubric instructions, the `-- '*.rs'` diff, "load the rust-review skill") → produced from `PROFILES.rust` fields (`rubricSkill`, `diffGlobs`, `ruleCatalog`, `reviewerAgent`).
  - the gate agent prompt (cargo fmt/clippy/check/nextest/audit/deny/semver + semgrep + the dep-context step 8) → `PROFILES.rust.gate(ctx)` returning the same string.
  - `detect`: `files => files.some(f => /\.rs$/.test(f) || /(^|\/)Cargo\.toml$/.test(f))`.
  - `securityHints`: the Rust security-sensitivity note (auth/unsafe/FFI/SQL/deps).

- [ ] **Step 3:** Rewire the engine to read from a single active profile for now (multi-language comes in Task 12): `const active = [PROFILES.rust]` temporarily, and everywhere the code used a bare `ALL_LENSES`/`LENS_BRIEF`/`craft:rust-reviewer`/`'*.rs'`, source it from the active profile. Keep the negative-space lens, security floor, INCOMPLETE, ruleId, budget gates exactly as-is.

- [ ] **Step 4: Syntax check.**

Run: `node --check workflows/review.js`
Expected: no output (exit 0).

- [ ] **Step 5: Verbatim-parity check** — confirm no prompt text changed during the move:

Run:
```bash
node -e "const s=require('fs').readFileSync('workflows/review.js','utf8'); for (const m of ['clippy::pedantic','Send/Sync','cargo semver-checks','Dependency context','negative-space','SECURITY rigor floor','ruleId']) if(!s.includes(m)){console.error('MISSING',m);process.exit(1)}; console.log('parity ok')"
```
Expected: `parity ok`.

- [ ] **Step 6: Commit.**

```bash
git add workflows/review.js
git commit -m "refactor(review): extract engine into review.js with inline PROFILES.rust"
```

### Task 8: Thin `rust-review` pin + repoint `rust-audit`

**Files:**
- Modify: `workflows/rust-review.js` (replace body with a pin)
- Modify: `workflows/rust-audit.js:191,197` (repoint `workflow('rust-review', …)` → `workflow('review', {languages:['rust'], …})`)

**Interfaces:**
- Consumes: workflow `review` (Task 7).
- Produces: `rust-review` still runnable as a human/agent root, Rust-pinned.

- [ ] **Step 1:** Replace the entire body of `workflows/rust-review.js` with a pin:

```js
export const meta = {
  name: 'rust-review',
  description: 'Rust-pinned entry to the generic review engine — reviews only the Rust files in a diff. Prefer `review` (auto-detects language); use this to force a Rust-only pass.',
  whenToUse: 'Explicit Rust-only diff review; the generic default is `review`.',
  phases: [{ title: 'Review', detail: 'delegates to the review engine pinned to the rust profile' }],
}
return await workflow('review', { ...(args || {}), languages: ['rust'] })
```

- [ ] **Step 2:** In `workflows/rust-audit.js`, change both `workflow('rust-review', <argsObj>)` calls (lines ~191 and ~197) to `workflow('review', { ...<argsObj>, languages: ['rust'] })`. This keeps audit at one nesting level (audit → review) rather than audit → rust-review → review.

- [ ] **Step 3: Syntax check both.**

Run: `node --check workflows/rust-review.js && node --check workflows/rust-audit.js`
Expected: exit 0.

- [ ] **Step 4:** Confirm no double-nesting remains: `grep -n "workflow('rust-review'" workflows/*.js` — Expected: no matches.

- [ ] **Step 5: Commit.**

```bash
git add workflows/rust-review.js workflows/rust-audit.js
git commit -m "refactor(review): rust-review becomes a thin pin; rust-audit calls review directly"
```

### Task 9: Rust regression check on the reference diff

**Files:** none (verification only).

- [ ] **Step 1:** Run the pinned-Rust engine on the reference base used previously (vodopad PR-1171). From the vodopad checkout, invoke the `review` workflow with `{ base: '<merge-base-of-1171>', languages: ['rust'] }` (or run `rust-review` there). This spawns subagents and costs tokens — run once.

- [ ] **Step 2:** Compare against the pre-refactor `rust-review` behavior: the run record in `~/.craft/runs/` should show the same shape (scout lenses, gate provenance, a Warning/Block verdict with located findings), and no engine error. Confirm the verdict and dimensions structure match a normal Rust review (not "no supported language").

- [ ] **Step 3:** If the run errors or the shape diverges, STOP — the extraction changed behavior; diff `review.js` against `rust-review.js`@`HEAD~2` for altered strings and fix before proceeding. Do not start Phase 3 until this is clean.

- [ ] **Step 4: Commit** (only if a fix was needed): `git commit -am "fix(review): restore Rust parity after extraction"`.

---

## Phase 3 — Nix profile + auto-detect

### Task 10: `craft:nix-reviewer` agent

**Files:**
- Create: `agents/nix-reviewer.md` (parallel to `agents/rust-reviewer.md`)

**Interfaces:**
- Produces: agentType `craft:nix-reviewer`, used as `PROFILES.nix.reviewerAgent` and as the standalone ad-hoc Nix reviewer.

- [ ] **Step 1:** Copy `agents/rust-reviewer.md` to `agents/nix-reviewer.md`; rewrite the frontmatter `name`/`description` for Nix and change the loaded rubric from `rust-review` to `nix-review`; swap the tool/gate references (cargo → nix flake check/statix/deadnix). Keep `tools: Read, Grep, Glob, Bash`.

- [ ] **Step 2: Validate frontmatter.** Run: `head -8 agents/nix-reviewer.md` — Expected: valid frontmatter, `name` referencing nix.

- [ ] **Step 3: Commit.**

```bash
git add agents/nix-reviewer.md
git commit -m "feat(nix): add nix-reviewer agent"
```

### Task 11: Add `PROFILES.nix` to `review.js`

**Files:**
- Modify: `workflows/review.js` (add `PROFILES.nix`)

**Interfaces:**
- Consumes: `nix-review` skill/rules (Task 5), `craft:nix-reviewer` (Task 10).
- Produces: `PROFILES.nix` implementing the same contract as `PROFILES.rust`.

- [ ] **Step 1:** Add `PROFILES.nix`:

```js
PROFILES.nix = {
  id: 'nix',
  detect: (files) => files.some(f => /\.nix$/.test(f) || /(^|\/)flake\.lock$/.test(f)),
  diffGlobs: ["'*.nix'", "'flake.lock'"],
  lenses: ['purity', 'reproducibility', 'injection', 'packaging', 'dev-env', 'modules', 'maintainability', 'intent'],
  lensBrief: {
    purity: 'purity: impure builtins (currentTime/getEnv/<nixpkgs>), fetchers without a fixed hash — anything that makes a build non-reproducible (PUR-*).',
    reproducibility: 'reproducibility: unpinned/channel inputs, missing flake.lock entries, import-from-derivation (IFD), --impure reliance (REP-*).',
    injection: 'injection: untrusted values interpolated into build or shell scripts; builtins.exec (INJ-*).',
    packaging: 'packaging: mkDerivation correctness — dep hashes (cargoHash/vendorHash/npmDepsHash), builder choice, phases, meta/license (PKG-*).',
    'dev-env': 'dev-env: devShell/direnv correctness, writeShellApplication, the allowUnfree-not-propagated-to-nix-develop gotcha (DEV-*).',
    modules: 'modules: NixOS/home-manager option typing and defaults, cross-platform (Linux+Darwin), secrets kept out of the store — agenix/sops-nix (MOD-*).',
    maintainability: 'maintainability: dead code (deadnix), anti-idioms (statix), needless rec/with, over-abstraction (MNT-*).',
    intent: 'intent / spec conformance: does the change do what it should? Compare against the stated intent.',
  },
  rubricSkill: 'nix-review',
  ruleCatalog: 'skills/nix-review/rules.md',
  reviewerAgent: 'craft:nix-reviewer',
  securityHints: 'Nix is security-sensitive when it touches secrets handling (agenix/sops-nix), fetchers/hashes, module security options, or build-script interpolation.',
  gate: (ctx) => `You are establishing the mechanical gate for a Nix review and collecting tool-grounded seeds. Diff base: ${ctx.baseRef ? '`' + ctx.baseRef + '`' : 'uncommitted / most recent commit'}.
1. If a \`flake.nix\` exists: \`nix flake check\` — a failure is a gate failure (failedChecks), not a seed.
2. Formatter: run \`alejandra --check .\` or \`nixpkgs-fmt --check\` (whichever the repo uses); mismatches are seeds (source "fmt", Low).
3. \`statix check\` — each diagnostic on changed files is a seed (source "statix", Low/Medium).
4. \`deadnix --fail\` — each dead binding on changed files is a seed (source "deadnix", Low).
5. \`nix eval\`/\`nix build\` the touched attrs for eval errors — an eval error on changed code is a gate failure.
${PROFILES.nix.depContext(ctx)}
Set provenance to a one-line summary. Put gate failures in failedChecks (NOT seedFindings). On every seed set \`ruleId\` to the matching nix-review rules.md ID (e.g. "MNT-001") or "".`,
  depContext: (ctx) => `6. **Dependency context** — resolve flake inputs against \`flake.lock\`; flag inputs that are unpinned, channel-based, or floating where they should be locked (source "dep-context", ruleId "DEP-001"). Best-effort; skip if no flake.`,
}
```

- [ ] **Step 2: Syntax check.** Run: `node --check workflows/review.js` — Expected: exit 0.

- [ ] **Step 3: Commit.**

```bash
git add workflows/review.js
git commit -m "feat(review): add PROFILES.nix (gate, lenses, dep-context)"
```

### Task 12: Auto-detect + multi-language merge

**Files:**
- Modify: `workflows/review.js` (replace the temporary `active = [PROFILES.rust]` with detection; make gate + lens fan-out iterate active profiles; merge)

**Interfaces:**
- Consumes: `PROFILES.rust`, `PROFILES.nix`, `args.languages`.
- Produces: `active` = detected-and-permitted profiles; one merged report/verdict/record.

- [ ] **Step 1:** Compute changed files once and detect:

```js
const changedFiles = (await sh(`git diff --name-only ${plan.baseRef ? '--merge-base ' + plan.baseRef : 'HEAD'}`)).split('\n').filter(Boolean)
const requested = Array.isArray(args?.languages) && args.languages.length ? args.languages : null
let active = Object.values(PROFILES).filter(p => (!requested || requested.includes(p.id)) && p.detect(changedFiles))
if (requested && !active.length) active = requested.map(id => PROFILES[id]).filter(Boolean)  // pinned but detect missed → honor the pin
if (!active.length) { /* emit "no supported language in this diff" report + record, return */ }
```

(If a `sh`/exec helper is not already present in the file, reuse the same command-run mechanism the gate/scout use — do NOT add Node `child_process`; the scout already shells out via its agent. If no in-script shell exists, have the scout agent return `changedFiles`/detected languages as part of its structured plan instead, and detect from that.)

- [ ] **Step 2:** Make the **gate** run per active profile and merge: worst `status`, joined `provenance`, concatenated `failedChecks` and `seedFindings` (tag each seed with its `profile.id` in `source` if useful).

- [ ] **Step 3:** Make the **lens fan-out** iterate `active.flatMap(p => plannedLensesFor(p).map(lens => ({ profile: p, lens })))`. Each worker uses `pair.profile`'s `lensBrief`, `rubricSkill`, `ruleCatalog`, `reviewerAgent`, `diffGlobs`. The negative-space lens runs per active profile. The dimensions tally key becomes `${p.id}:${lens}`.

- [ ] **Step 4:** Verdict = worst across all confirmed; report lists findings across languages under one set of severity sections; run record carries `languages: active.map(p=>p.id)`.

- [ ] **Step 5: Syntax check.** Run: `node --check workflows/review.js` — Expected: exit 0.

- [ ] **Step 6: Commit.**

```bash
git add workflows/review.js
git commit -m "feat(review): auto-detect languages and merge multi-language review into one report"
```

### Task 13: `nix-review` pin

**Files:**
- Create: `workflows/nix-review.js`

- [ ] **Step 1:** Mirror the rust pin, `languages: ['nix']`:

```js
export const meta = {
  name: 'nix-review',
  description: 'Nix-pinned entry to the generic review engine — reviews only the Nix files in a diff. Prefer `review` (auto-detects language); use this to force a Nix-only pass.',
  whenToUse: 'Explicit Nix-only diff review; the generic default is `review`.',
  phases: [{ title: 'Review', detail: 'delegates to the review engine pinned to the nix profile' }],
}
return await workflow('review', { ...(args || {}), languages: ['nix'] })
```

- [ ] **Step 2: Syntax check.** Run: `node --check workflows/nix-review.js` — Expected: exit 0.

- [ ] **Step 3: Commit.**

```bash
git add workflows/nix-review.js
git commit -m "feat(nix): add nix-review workflow pin"
```

### Task 14: Nix + mixed-diff smoke test

**Files:** none (verification only).

- [ ] **Step 1:** In a repo with a `flake.nix`, make a small deliberate Nix mistake (e.g. a `fetchFromGitHub` with `hash = lib.fakeHash;` or a dead `let` binding) and run `workflow('review', { languages: ['nix'] })`. Expected: a located finding citing a `PUR-*`/`PKG-*`/`MNT-*` ruleId and a non-Approve verdict.

- [ ] **Step 2:** In a repo touching both `.rs` and `.nix`, run `review` with no `languages`. Expected: the run record shows `languages: ['rust','nix']` and findings from both profiles in one report.

- [ ] **Step 3:** No commit (verification). If defects found, fix in `review.js`/`PROFILES.nix` and re-run.

---

## Phase 4 — Docs

### Task 15: Update CLAUDE.md / README.md / MAP.md

**Files:**
- Modify: `CLAUDE.md` (review-handler table)
- Modify: `README.md` (workflow list)
- Modify: `MAP.md` (workflows section)

- [ ] **Step 1:** In `CLAUDE.md`, change the default review handler from `rust-review` to `review` (auto-detects language); add rows for `rust-review`/`nix-review` as explicit language pins; note `craft:nix-reviewer` alongside `rust-reviewer`.

- [ ] **Step 2:** In `README.md`, add `review` (generic, auto-detect) as the default workflow; describe `rust-review`/`nix-review` as pins; add the `nix-reviewer` agent row and the 5 nix skills.

- [ ] **Step 3:** In `MAP.md`, add a `review` workflow row and adjust the `rust-review` row to "thin pin → review"; add `nix-reviewer` to the agents table.

- [ ] **Step 4: Validate.**

Run: `grep -n "\`review\`" CLAUDE.md README.md MAP.md | head`
Expected: `review` referenced as the default in each.

- [ ] **Step 5: Commit.**

```bash
git add CLAUDE.md README.md MAP.md
git commit -m "docs(review): default review is now the generic engine; document language pins"
```

---

## Self-Review (checklist run against the spec)

- **Spec coverage:** engine/profile split → Tasks 7,11,12; inline registry → Task 7; auto-detect + merge → Task 12; thin pins + repointed audit → Tasks 8,13; Nix profile → Tasks 10,11; nix-* skills → Tasks 1–5; nix-review rubric+rules → Task 5; registration/docs → Tasks 6,15; regression mitigation → Task 9. All spec sections have a task.
- **Placeholder scan:** skill-content steps name exact concepts/gotchas/commands (not "add appropriate content"); engine steps carry real code; verification steps carry exact commands and expected output.
- **Type/name consistency:** the profile contract fields (`id/detect/diffGlobs/lenses/lensBrief/rubricSkill/ruleCatalog/reviewerAgent/gate/depContext/securityHints`) are used identically in Tasks 7, 11, 12; `craft:nix-reviewer` defined in Task 10 and consumed in Task 11; `languages` arg defined in Task 7 and consumed in Tasks 8,12,13; rule-ID prefixes match between Task 5's catalog and Task 11's lensBriefs.

## Non-goals (from spec)

No cross-language finding correlation; no shared `lib/` engine module (sandbox); no router skill.
