# CI-aware mechanical gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every craft review agent consume green CI check results for `fmt`/`clippy`/`test`/`build` instead of recomputing them locally, falling back to the local gate whenever CI gives no conclusive signal.

**Architecture:** The CI-aware protocol is written once in `skills/rust-review/SKILL.md` (the canonical home, "Step 1 — Establish the gate (CI-aware)"). Each agent's gate step references that protocol and applies its own per-tool coverage map. Detection is `gh pr checks` with graceful fallback; security tools (`audit`/`deny`) always run locally.

**Tech Stack:** Markdown skill/agent files; one plain-JS workflow (`workflows/rust-audit.js`); `gh` CLI for CI detection.

## Global Constraints

- **No test runner.** This repo edits Markdown and one JS workflow. A task's verification is a concrete check — `rg -n "<phrase>" <file>` to confirm content landed, YAML frontmatter still parses, cross-references resolve to real files, and `node --check workflows/rust-audit.js` for the JS. Never fabricate a pytest cycle.
- **Commit messages:** write as the user — NO `Co-Authored-By: Claude`, no "Generated with Claude Code" footer.
- **Detection command (verbatim):** `gh pr checks --json name,state,bucket,link` for the current branch.
- **Fallback rule (verbatim intent):** `gh` missing / unauthenticated / offline / no PR found / checks pending / check name unrecognized → run that command locally. The safe default is an extra run, never a skipped check.
- **Name heuristics (verbatim):** substring match on `fmt`, `clippy`, `test`, `build`/`check`.
- **Hybrid rule (verbatim):** `audit` / `deny` always run locally if installed, regardless of CI.
- **Provenance line:** the `## Gate` output cites `via CI · PR #N` or `local` per signal.
- **Out of scope:** `agents/rust-architecture-reviewer.md` (no build gate), `CLAUDE.md`, the dispatcher brief.

---

### Task 1: Canonical CI-aware gate in `rust-review` skill

**Files:**
- Modify: `skills/rust-review/SKILL.md` — replace "Step 1 — Mechanical gate" (currently lines ~16-30), update the Step 3 verdict table (~104-106), and add one note to the "what proves what" table (~132-146).

**Interfaces:**
- Produces: the canonical heading **"Step 1 — Establish the gate (CI-aware)"** and the 3-part protocol (detect → fmt/clippy/test/build via CI-or-local → audit/deny always local). Tasks 2-4 reference this by name ("the CI-aware gate in `rust-review`") rather than restating it.

- [ ] **Step 1: Replace the Step 1 mechanical-gate section**

Find the current block (heading `## Step 1 — Mechanical gate` through the line ending `...only that it's reviewable.`) and replace it with:

```markdown
## Step 1 — Establish the gate (CI-aware)

The mechanical gate is non-negotiable: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`, and (if installed) `cargo audit` / `cargo deny check` must be green before human-style review is worth doing. But **before running a check locally, ask whether CI already computed it on this PR; if a conclusive required check covers it and is green, consume that result instead of recomputing.** Re-running a cold build the PR already ran in CI is slow, sometimes impossible (no toolchain/network), and redundant.

Establish each signal:

1. **Detect the PR's CI** for the current branch:
   ```bash
   gh pr checks --json name,state,bucket,link
   ```
   If `gh` is missing, unauthenticated, offline, or finds no PR → fall straight through to the local gate (never fail on detection).
2. **`fmt` / `clippy` / `test` / `build`** — if a required check whose name matches the command (substring: `fmt`, `clippy`, `test`, `build`/`check`) is conclusive:
   - green → treat that command as **PASSED**; record provenance `via CI · PR #N`;
   - failed → the gate is red: verdict **Block**, cite the failed check name + link, stop;
   - pending / absent / name unrecognized → run that command locally (the safe default is an extra run, never a skipped check):
     ```bash
     cargo fmt --check
     cargo clippy --all-targets -- -D warnings
     cargo test                         # or: cargo nextest run + cargo test --doc
     ```
3. **`audit` / `deny`** — always run locally if installed, regardless of CI (cheap, usually absent from CI):
   ```bash
   cargo audit                        # if cargo-audit present
   cargo deny check                   # if cargo-deny present
   ```
   Setting up / interpreting `cargo audit` + `cargo deny` → `rust-security`.

If any `fmt`/`clippy`/`test`/`build` signal is red (CI or local), stop and report — don't review further. A green gate is the floor, not the ceiling — whatever its provenance, it means the change is *reviewable*, not that it's good.
```

- [ ] **Step 2: Update the Step 3 verdict table to accept a CI signal**

Replace the three verdict rows with:

```markdown
| **Approve** ✅ | gate green (CI or local), no CRITICAL or HIGH |
| **Warning** ⚠️ | gate green (CI or local), MEDIUM only — list them, leave merge to author |
| **Block** ⛔ | gate red (CI or local), or any CRITICAL/HIGH — list each with file:line and the fix |
```

Immediately after the table's existing trailing sentence (`...a finding without a location isn't actionable.`) add:

```markdown
"Gate green / red" is read from Step 1 — the signal may come from a green required CI check or a local run. Cite which in the `## Gate` line of the output.
```

- [ ] **Step 3: Add a CI-proof note to the "what proves what" table**

Immediately after the "what proves what" table (after the `requirements met` row), add:

```markdown
A green **required CI check** for the same command is also valid proof of that command (see Step 1 — Establish the gate). The point of the table is that *some* fresh authoritative signal exists — CI or local — not that you must re-run it yourself.
```

- [ ] **Step 4: Verify the content landed and frontmatter is intact**

Run:
```bash
rg -n "Establish the gate \(CI-aware\)|gh pr checks --json|always run locally|gate green \(CI or local\)" skills/rust-review/SKILL.md
head -4 skills/rust-review/SKILL.md   # frontmatter --- ... --- still present
```
Expected: all four phrases match; file still opens with `---` frontmatter.

- [ ] **Step 5: Commit**

```bash
git add skills/rust-review/SKILL.md
git commit -m "feat(rust-review): make the mechanical gate CI-aware (canonical protocol)"
```

---

### Task 2: CI-aware gate in `rust-reviewer` agent

**Files:**
- Modify: `agents/rust-reviewer.md` — replace Step 1 of the Workflow and the `## Gate` block of the output format.

**Interfaces:**
- Consumes: the canonical protocol from Task 1 (referenced by name, not restated in full).
- Coverage map for this agent: trust CI for `fmt`/`clippy`/`test`/`build`; `audit`/`deny` always local.

- [ ] **Step 1: Replace Workflow Step 1 (the mechanical gate)**

Find the current `1. **Mechanical gate.** ...` block (through `If fmt/clippy/test fail → verdict is **Block**: report the failure and stop.`) and replace it with:

```markdown
1. **Establish the gate (CI-aware).** Don't recompute what CI already ran. Load the `rust-review` skill for the full protocol; in short:
   - Detect the PR's CI for the current branch (degrade to the local gate if `gh` is absent/unauthenticated/offline or there's no PR):
     ```bash
     gh pr checks --json name,state,bucket,link
     ```
   - **fmt / clippy / test / build** — if a required check matching the command by name (`fmt`, `clippy`, `test`, `build`/`check`) is green, treat it as PASSED and record `via CI · PR #N`; if it failed → verdict **Block**, cite the check + link, stop; if pending/absent/unrecognized, run it locally:
     ```bash
     cargo fmt --check
     cargo clippy --all-targets -- -D warnings
     cargo test            # or: cargo nextest run && cargo test --doc
     ```
   - **audit / deny** — always run locally if installed (cheap, usually absent from CI):
     ```bash
     if command -v cargo-audit >/dev/null; then cargo audit || echo advisories-found; else echo "cargo-audit not installed"; fi
     if command -v cargo-deny  >/dev/null; then cargo deny check || echo advisories-found; else echo "cargo-deny not installed"; fi
     ```
   If any fmt/clippy/test/build signal is red (CI or local) → verdict is **Block**: report the failure with its provenance and stop.
```

- [ ] **Step 2: Update the output-format `## Gate` block**

Replace the current `## Gate` example line (`fmt ✓ · clippy ✓ · test ✓ · audit ✓`) with:

```markdown
## Gate
clippy ✓ · test ✓ · fmt ✓   (via CI · PR #123)
audit ✓ · deny ✓            (local)
```

- [ ] **Step 3: Verify**

Run:
```bash
rg -n "Establish the gate \(CI-aware\)|gh pr checks --json|via CI · PR" agents/rust-reviewer.md
head -6 agents/rust-reviewer.md   # frontmatter (name/description/tools/model) intact
```
Expected: phrases match; frontmatter intact.

- [ ] **Step 4: Commit**

```bash
git add agents/rust-reviewer.md
git commit -m "feat(rust-reviewer): consume CI gate signal, fall back to local"
```

---

### Task 3: "Check CI first" in `rust-security-scanner` agent

**Files:**
- Modify: `agents/rust-security-scanner.md` — add a leading "check CI first" step for `audit`/`deny`; `geiger`/`semgrep` stay local.

**Interfaces:**
- Consumes: the canonical protocol from Task 1.
- Coverage map: trust CI for `audit`/`deny` if a green check matches by name; `geiger`/`semgrep` always local.

- [ ] **Step 1: Insert the CI-first step**

Directly under the `## Workflow` heading, before the current `1. **Run the tools** ...`, insert:

```markdown
0. **Check CI first (audit/deny).** If the current branch has a PR, a green *required* check whose name matches `audit` or `deny` can be consumed instead of re-running that tool — `gh pr checks --json name,state,bucket,link`; degrade to local if `gh`/PR is absent, unauthenticated, offline, or the check is pending/unrecognized. `geiger` and `semgrep` are almost never in CI — always run them locally. This mirrors the CI-aware gate in the `rust-review` skill. Record provenance (`via CI #N` vs `local`) in the Tools line.
```

- [ ] **Step 2: Note provenance in the Tools output line**

In the output-format example, change the `## Tools` example line to show provenance, e.g.:

```markdown
## Tools
audit ✓ (via CI #123) · deny ✓ (via CI #123) · geiger ✓ (local) · semgrep (not installed)
```

- [ ] **Step 3: Verify**

Run:
```bash
rg -n "Check CI first \(audit/deny\)|gh pr checks --json|always run them locally" agents/rust-security-scanner.md
head -6 agents/rust-security-scanner.md
```
Expected: phrases match; frontmatter intact.

- [ ] **Step 4: Commit**

```bash
git add agents/rust-security-scanner.md
git commit -m "feat(rust-security-scanner): consume CI audit/deny checks when green"
```

---

### Task 4: "Check CI first" in `rust-miri` agent

**Files:**
- Modify: `agents/rust-miri.md` — add a CI-first step for a `miri` job; otherwise run locally as today.

**Interfaces:**
- Consumes: the canonical protocol from Task 1.
- Coverage map: trust CI for a green required check named `miri`; otherwise run Miri locally.

- [ ] **Step 1: Insert the CI-first step**

Directly under the `## Workflow` heading, before the current `1. **Check Miri is available** ...`, insert:

```markdown
0. **Check CI first.** If the current branch's PR has a green *required* check named `miri` (`gh pr checks --json name,state,bucket,link`; degrade to local if `gh`/PR is absent, unauthenticated, offline, or the check is pending), you may consume it as the soundness signal and note `via CI #N`. Miri jobs in CI are rare, so you will usually run it locally as below. This mirrors the CI-aware gate in the `rust-review` skill.
```

- [ ] **Step 2: Verify**

Run:
```bash
rg -n "Check CI first|named .miri.|mirrors the CI-aware gate" agents/rust-miri.md
head -6 agents/rust-miri.md
```
Expected: phrases match; frontmatter intact.

- [ ] **Step 3: Commit**

```bash
git add agents/rust-miri.md
git commit -m "feat(rust-miri): consume a green CI miri check when present"
```

---

### Task 5: Carry gate provenance through `rust-audit` synthesis

**Files:**
- Modify: `workflows/rust-audit.js` — the review-dimension task prompt and the synthesis prompt.

**Interfaces:**
- Consumes: the review agent (Task 2) now reports a `## Gate` line with provenance in its summary.
- No schema change — provenance rides in the agent's free-text `summary`.

- [ ] **Step 1: Ask the review dimension to state gate provenance**

In the review task (the `agent(...)` call with `label: 'review:diff'`), change the prompt's trailing sentence `Return your verdict and findings.` to:

```javascript
    `Review the Rust diff for mergeability using the rust-review rubric (load the rust-review skill). ${baseRef
      ? `Diff base: \`${baseRef}\`.`
      : 'There is no clean base ref — review uncommitted changes, or the most recent commit if the tree is clean.'} Establish the gate CI-aware (consume green required CI checks; never silently skip a check) and state its provenance (CI vs local) in your summary. Return your verdict and findings.`,
```

- [ ] **Step 2: Surface provenance in the synthesis prompt**

In the synthesis `agent(...)` prompt, after the existing numbered item `4. A short **"Fix first"** list ...`, add a fifth item:

```javascript
4. A short **"Fix first"** list — the few highest-leverage items.
5. If the review dimension's summary names a **gate provenance** (CI vs local), surface it in one line under the verdict so a reader knows whether the mechanical gate was consumed from CI or run locally.
```

(Replace the existing item-4 line with these two lines so numbering stays contiguous.)

- [ ] **Step 3: Verify the script still parses and the text landed**

Run:
```bash
node --check workflows/rust-audit.js
rg -n "state its provenance \(CI vs local\)|gate provenance \(CI vs local\)" workflows/rust-audit.js
```
Expected: `node --check` exits 0 (no output); both phrases match.

- [ ] **Step 4: Commit**

```bash
git add workflows/rust-audit.js
git commit -m "feat(rust-audit): carry gate provenance from review dimension into synthesis"
```

---

## Self-Review

**Spec coverage:**
- "Canonical home" (Step 1 → CI-aware) → Task 1 ✅
- Gate algorithm (detect → CI-or-local → audit/deny local) → Task 1 (skill) + Task 2 (reviewer) ✅
- Verdict/output provenance → Task 1 (verdict table) + Task 2 (`## Gate`) ✅
- Per-agent coverage map: rust-reviewer → Task 2; rust-security-scanner → Task 3; rust-miri → Task 4; rust-architecture-reviewer → intentionally untouched (Global Constraints) ✅
- `workflows/rust-audit.js` carries provenance → Task 5 ✅
- "Brief / CLAUDE.md — no change" → respected (out of scope in Global Constraints) ✅

**Placeholder scan:** No TBD/TODO; every edit shows the exact replacement text and an exact verification command. ✅

**Type/name consistency:** The detection command `gh pr checks --json name,state,bucket,link`, the name heuristics (`fmt`/`clippy`/`test`/`build`/`check`), the provenance string `via CI · PR #N`, and the "mirrors the CI-aware gate in `rust-review`" pointer are used identically across Tasks 1-5. ✅
