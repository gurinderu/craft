# Round-aware re-review — design

**Status:** proposed
**Date:** 2026-07-15
**Skill/engine touched:** `review` workflow (`workflows/review.js`), `lib/run-record.mjs` mirror,
`triage-findings` + `addressing-findings` skills.

## Problem

Every review is stateless. Round N is literally the first pass run again by a fresh agent with no
memory of round N−1. Four symptoms — all one root cause (**no persisted, disposition-annotated
finding ledger keyed to the branch**):

1. **Forgets the prior round.** Re-raises findings the author already dismissed; no memory of
   confirmed/rejected findings or author justifications.
2. **Doesn't verify fixes head-on.** The real job of a re-review — confirm each prior finding is
   actually closed by its fix, and that the fix introduced no regression — is not a distinct task.
3. **Verdict is unstable.** Severity is re-derived from scratch by nondeterministic agents each
   round, with no anchor to the prior round.
4. **Expensive/slow.** The full lens fan-out re-runs against `base...HEAD` even when only a couple
   of files changed since the last round.

Fix the root and all four regress together.

### Two kinds of disposition (design-defining constraint)

- **`closed`** (finding resolved by a fix) — the re-review can determine this *itself* by checking
  the cited site.
- **`rejected` / `justified`** (author deliberately dismissed a false-positive, or accepted with a
  written justification) — this **cannot** come from the review engine. It is born in
  `triage-findings` / `addressing-findings` / PR-thread resolution.

Therefore the ledger must be written by **both** the review engine **and** the fix-loop skills.
Without the human-sourced dispositions, "stop re-raising dismissed findings" is unfixable.

## Decision

Approach **A**: round ledger + a re-review mode inside the *same* `review` workflow, with
**automatic round detection** and an explicit override. One entry point; the round is inferred, not
flagged.

## Design

### 1. Finding ledger (foundation)

Extend the existing `~/.craft/runs/` store. Today each per-run JSON carries only a severity summary;
we start persisting the **full findings list with verdicts**, plus a **branch pointer** so round N
can find round N−1.

Round record (key = `project + branch`; fall back to PR number when available):

```jsonc
{
  "round": 2,
  "branch": "feature/x",
  "head": "<commit SHA the review ran against>",
  "base": "<diff base>",
  "ts": "…",
  "findings": [
    {
      "fp": "<line-tolerant fingerprint, see §2>",
      "file": "src/foo.rs",
      "line": 42,                // re-computed each round, informational only
      "symbol": "Foo::bar",      // enclosing fn/type
      "severity": "High",
      "tier": "confirmed",       // engine verdict: confirmed | suspected | refuted
      "disposition": "open",     // open | closed | rejected | justified | deferred
      "source": "safety",
      "ruleId": "SAF-002",
      "title": "…",
      "why": "…"
    }
  ]
}
```

Writers and what each may set:

| Writer | Sets |
|---|---|
| `review` workflow | `findings`, `tier`, and auto-`closed` (when it confirms a prior finding's site is fixed) |
| `triage-findings` / `addressing-findings` | `rejected` / `justified` / `deferred` / `closed` |

Disposition alignment with existing triage verdicts (`lib/run-record.mjs`
`TRIAGE_VERDICTS = accept | reject | defer | needs-decision | conflict`):

- `reject` → `rejected`
- `defer` → `deferred`
- `accept` → stays `open` until a fix lands, then `closed`
- `needs-decision` / `conflict` → stays `open` (still needs adjudication)

`justified` has no triage-verdict source — it is set only by `addressing-findings` when a finding is
kept (typically a Warning) but explicitly justified in the PR body rather than fixed.

The record format is a documented **contract** shared by the workflow and the two skills.

### 2. Cross-round finding identity (the crux)

`file:line` is useless as a key: a fix shifts lines and the same defect moves. Use a **line-tolerant
fingerprint**:

```
fp = hash(file + enclosing_symbol + ruleId + title_shingle)
```

- `enclosing_symbol` — the name of the enclosing function/type, resolved by nav/grep, **not** a line
  number.
- `title_shingle` — the normalized word-set of the title.
- At re-review, `line` is **re-computed** (grep the symbol) rather than trusted from the prior round.

Matching "same finding across rounds" is by `fp` with a fuzzy allowance on the title shingle — not by
exact line. **Decision:** fingerprint at the *symbol* level (accepted default).

### 3. Two tracks (the re-review mode)

At scout: if a prior round exists for this branch **and its `head` is an ancestor of the current
HEAD**, enter re-review mode. (Ancestor check guards against force-push/rebase producing a bogus
"round 2".) Work splits in two:

**Adjudicate track** — one pass per prior finding:

- `disposition ∈ {rejected, justified}` → **do not re-raise**. Exception: if the code around `fp`
  changed since the dismissal, resurface as *reopened: justification may be stale*. Otherwise carry
  forward silently (collapsed "carried" block in the report).
- `disposition ∈ {open, deferred}` or `tier = confirmed` → dispatch a targeted check: is the finding
  still at its (re-computed) site? → `still-open`; gone → `resolved`; a new defect now sits there →
  `regressed`.

**Delta track** — lenses run against `prevRound.head...HEAD` (the fix commits), **not**
`base...HEAD`. Cheap, and catches regressions the fixes introduced.

**Override `fresh`** — restores the full `base...HEAD` pass for a clean full audit. Accepted risk of
the delta default: something round 1 missed in *unchanged* code is not re-opened by round 2 unless
`fresh` is passed. Re-review is about the fixes, not a fresh audit.

### 4. Verdict stability

Two levers, both falling out of §2–§3:

1. **Severity anchor** — a carried-forward finding keeps its prior-round severity when the code
   around its `fp` is unchanged. Severity is re-derived only for genuinely new or changed findings.
2. **No re-litigation** — `rejected`/`justified` never go back through the lenses, removing the main
   source of verdict churn.

Final verdict is computed over the union of `still-open` + `regressed` + new delta findings.
`resolved` and `carried` do not count toward the verdict.

### 5. Report shape

Re-review returns structure the first pass has no reason to produce:

- ✅ **Resolved** — was open, closed by a fix
- 🔴 **Still open** — was open, still present
- ⚠️ **Regressed** — a fix broke something / a new bug from a fix
- 🆕 **New** — delta track
- 🔽 **Carried** — `rejected`/`justified`, collapsed, for transparency, not in the verdict

## Scope of implementation

- `workflows/review.js` — scout (load prior round, ancestor check, enter mode), new adjudicate stage,
  delta-scoped lens diff range, synthesize (merge the two tracks into the §5 report), `logRun`
  (persist full findings + branch pointer).
- `lib/run-record.mjs` — extend the record schema; keep the workflow's inlined mirror in sync.
- `triage-findings` / `addressing-findings` skills — write dispositions to the ledger under the §1
  contract.
- This spec.

## Open questions / accepted defaults

- **Fingerprint at symbol level** — accepted. If functions are very large, a symbol may host several
  distinct findings; the `ruleId + title_shingle` components disambiguate.
- **Delta track by default** — accepted, with `fresh` override for a full re-audit.

## Non-goals

- Making review deterministic. The anchor stabilizes *carried* findings; new findings are still
  agent-derived.
- A cross-branch or cross-PR finding history. The ledger is keyed per branch.
