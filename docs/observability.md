# Observability — craft run records

Every `rust-audit` / `rust-review` / `triage-findings` run, and every directly-dispatched review
agent, writes a structured record to a global per-user store so runs can be studied later.

## Store

```
~/.craft/runs/
  index.jsonl              # append-only, one compact JSON line per run — load with jq/pandas
  <ts>-<kind>-<name>.json  # full per-run detail
  README.md                # generated on first run
```

## Record schema (`schemaVersion: 1`)

Common: `ts`, `runtime` (`"claude-code"` | `"opencode"`), `kind` (`workflow`|`agent`), `name`, `project`, `commit`, `dirty`, `verdict`,
`findings: {total, bySeverity:{Critical,High,Medium,Low,Info}}`, `nested`, `via`.

Workflows add: `scout`, `dimensions[]`, `verification {candidates, confirmed, refuteRate}`,
`notRun[]`, `outputTokens` (approximate — `budget.spent()`, shared per-turn pool). The `scout`
shape is workflow-specific — rust-review records `{size, lenses, model, maxRounds, verifyVotes}`,
rust-audit records `{baseRef, crateCount, changedCrateCount, edgeCount, hasUnsafe}`; see each
workflow's `logRun`/record assembly for the exact fields.
`triage-findings` is not a review: it carries `verdict: ""` and `findings` summarizing the findings
it *triaged* (total + severity mix of the gathered raw findings, not findings it produced). It adds
`sources[]` (`{source, count}` per gathered source) and `triage {gathered, validated, accept,
reject, defer, needs-decision, conflict}` (disposition tally from the plan ledger, or the solo
validations when the plan phase produced nothing); `notRun[]` lists requested sources that failed to
gather. It has no `scout`/`dimensions`/`verification`/`outputTokens`.
The `rust-security-scanner` agent additionally records `toolsRun[]` (which cargo tools actually ran).
rust-review records also carry `gate {status, provenance}` (always) and `failedChecks[]`
(gate-fail path only); these summary-only extras are NOT carried into the `index.jsonl` projection.

Records carry a `runtime` field — `"claude-code"` for the Claude Code workflows/agents,
`"opencode"` for the opencode adapter. opencode records are a deterministic subset: `findings`
is `null` (no structured findings), and there is no `outputTokens` (no token meter) — so
`findingsTotal` is `null` in their index projection.

For rust-review, `dimensions[]` accounts for per-lens findings only — seed/gate findings
(e.g. clippy-pedantic, semver-checks) are included in `findings.total` but are not attributed
to a lens row, so the per-dimension counts may sum to less than `findings.total`.

`index.jsonl` carries the summary projection (drops `dimensions`/`scout`/`verification` detail,
adds `findingsTotal`).

## How it is produced

Workflow scripts are sandboxed (no filesystem, no clock), so they assemble the record object and
hand it to a cheap **logger agent** that stamps `ts`/`project`/`commit`/`dirty` and writes the
files. The shaping helpers are tested in `lib/run-record.mjs`; the workflow scripts inline verbatim
copies (the sandbox can't `import`). Standalone agents self-log via their `.md` Observability
section, suppressed when run as a workflow sub-agent.

## Studying the data

```bash
# runs per handler
jq -s 'group_by(.name)[] | {name: .[0].name, runs: length}' ~/.craft/runs/index.jsonl
# everything that blocked
jq 'select(.verdict | test("Block"))' ~/.craft/runs/index.jsonl
# unused-crate verification refute rate over audit runs (from detail files)
jq -s '[.[] | select(.name=="rust-audit") | .verification | select(.!=null)]' ~/.craft/runs/*-workflow-rust-audit.json
```

Design rationale and accepted limitations: see
`docs/superpowers/specs/2026-06-24-observability-design.md`.

## Out of scope (v1)

Per-agent timing/token cost (only in raw `agent-*.jsonl` transcripts) and any analysis UI.
