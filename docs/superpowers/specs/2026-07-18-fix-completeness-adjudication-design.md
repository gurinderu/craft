# Fix-completeness adjudication for the review workflow

**Date:** 2026-07-18
**Scope:** `workflows/review.js` only (adversarial-review has no ledger/re-review rounds).

## Problem

On a re-review round, the adjudicate track checks each prior finding literally: re-locate
the symbol, read it, decide `resolved` / `still-open` / `regressed`. A fix that closes the
*described instance* but not the *defect class* passes as `resolved`.

Real case (lightmare PR #663): the finding "reused tenant CIDR adds a competing hub route"
was fixed with an exact string-equality conflict check — overlapping-but-not-identical
CIDRs still hijack traffic. A literal adjudicator sees "conflict detection added" and
closes the finding. Same round: a spoke↔spoke drop policy scoped to egress CIDRs only,
while the default route it compensates is VPC-wide.

## Design

Approach C — prompt hardening for every prior, plus an independent red-team pass for
heavy priors adjudged resolved.

### 1. Adjudicator prompt hardening (`toCheck` branch)

New METHOD in the adjudicator prompt:

1. State in one sentence the **invariant** the finding violated (derive from `why`/`title`).
2. Re-locate the symbol and read the fix.
3. Construct **at least two concrete attacks** — an input/state that violates the invariant
   while the fix is in place (canonical example: two CIDRs that overlap but are not equal
   as strings) — and check each against the actual code.
4. Return `resolved` only if every attack fails. A successful attack → `still-open`, with
   the attack appended to `why` as `fix incomplete: <attack>`.

`ADJUDICATE_SCHEMA` gains two **required** fields (forcing the model through the steps):

- `invariant: string` — the one-sentence invariant.
- `attack: string` — the successful attack, `''` if none succeeded.

### 2. Red-team pass for Critical/High priors

For a prior with severity Critical or High that the adjudicator marked `resolved`, chain a
fresh attacker agent inside the same per-finding thunk (no barrier; stays inside the
existing `parallel` over `toCheck`):

- The attacker does **not** see the adjudicator's verdict — only the finding, the invariant,
  and the instruction to construct inputs that defeat the fix in the current tree.
- Schema `ATTACK_SCHEMA { defeated: boolean, attack: string }`.
- `defeated=true` → status overridden to `still-open`,
  `why: … fix incomplete (red-team): <attack>`; otherwise stays `resolved`.
- Model: the same `lensModel` as the adjudicator; label `redteam:<file>:<line>`,
  phase `Adjudicate`. Expected cost: 1–3 extra agents per round.

### 3. No new statuses

The `resolved|still-open|regressed` enum, verdict logic, synthesis prompt, and the
11-field ledger schema are unchanged. A defeated fix is `still-open` (the class is still
present); the attack travels in `note`/`why`. `resolved` priors still drop out of the
carried ledger.

### 4. Telemetry & tests

- Adjudicate log line gains `· N overturned by red-team`.
- Verification: existing structural lint `lib/review-registry.test.mjs` must still eval
  the script; run `node --test lib/`.

## Error handling

- Adjudicator died (`ragent` → null): unchanged — status defaults to `still-open` (safe).
- Red-team agent died: treat as `defeated=false` (keep `resolved`) — the adjudicator
  already did an attack pass of its own; a dead red-teamer must not spuriously reopen
  findings.

## Out of scope

- adversarial-review.js (no prior-finding mechanics).
- New report sections; benchmarks/eval corpus (discussed separately, deferred).
