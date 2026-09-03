# Observability — craft run records

Every `rust-audit` / `rust-review` / `adversarial-review` / `triage-findings` run, and every
directly-dispatched review agent, writes a structured record to a global per-user store so runs
can be studied later.

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

**Engine identity** — `craftVersion` (the plugin release, stamped from a `CRAFT_VERSION` const that
`lib/check-workflows.mjs` keeps in sync with `.claude-plugin/plugin.json`) and `craftCommit`
(craft's own git HEAD, best-effort via `$CLAUDE_PLUGIN_ROOT`). Distinct from `commit`, which is the
**reviewed project's** HEAD, and from `schemaVersion`, which versions this record format.

Both ride in `index.jsonl` as well as the detail file. Without them, findings-per-run and refute
rates average across every rubric change the store has ever seen, so "did tightening that lens
help?" cannot be answered.

**But a release version does not identify an engine, and that is the whole point of the
`engineRevision` field.** One version can span a behaviour change — the run that made rigor
deterministic shipped under `0.16.0` and no release followed, so records of two different engines
carry the same string and only a timestamp separates them. `engineRevision` is the discriminator:
a hand-bumped integer in `lib/run-record.mjs`, stamped at the single write choke point, forming an
engine identity of `runtime + craftVersion + rN`. Bump it in the same commit that changes what the
telemetry means. Nothing can enforce that, and a missed bump asserts sameness — which is why a
record carrying no revision reads as `r?` and is never folded into the current engine.

`node lib/analyze-runs.mjs --engine latest` (or `--engine "claude-code 0.16.0 r2"`) slices to one
engine; `--version` still exists and still filters, but a version slice is not an engine slice.
With no flag the report names the engines it spans **before** any rate, and says so plainly when it
cannot separate them — a caveat under the numbers arrives after they have been read as a
before/after. `engineRevision` is not in `indexProjection`: nothing outside the write script can stamp it, so as
an index column it would only ever be whatever a caller guessed, and the one engine-aware reader
loads the detail files anyway. This is also why every record-filing engine — `review`,
`adversarial-review`, `rust-audit`, `triage-findings` — writes through
`lib/craft-log-run.mjs` rather than instructing a model to assemble the record: an engine that
computes the fields from a prompt cannot produce this one at all, so every record it files is
excluded from `--engine latest` by construction. The shared write path is `lib/run-logging.mjs`,
inlined into each engine by the `craft-inline` gate.
Records written before these fields carry `null` and are outside any filter.

Workflows add: `scout`, `dimensions[]`, `verification {candidates, judged, confirmed, refuted, died, refuteRate}` (`refuteRate` is over what was *judged*, and is `null` when nothing was — a run whose verifiers all died reports no rate rather than a rate of zero),
`notRun[]`, `outputTokens` (approximate — `budget.spent()`, shared per-turn pool). The `scout`
shape is workflow-specific — rust-review records `{size, lenses, model, maxRounds, verifyVotes}`,
rust-audit records `{baseRef, crateCount, changedCrateCount, edgeCount, hasUnsafe}`,
adversarial-review records `{size, lenses, indexed, batch}`; see each
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
For adversarial-review the opposite skew applies: a deduped finding corroborated by several lenses
counts in each corroborating lens's row, so per-dimension counts may sum to more than
`findings.total`.

`index.jsonl` carries the summary projection (drops `dimensions`/`scout`/`verification` detail,
adds `findingsTotal`).

## How it is produced

Workflow scripts are sandboxed (no filesystem, no clock), so they assemble the record object and
hand it to a cheap **logger agent** whose whole job is transport: it stages the record through a
per-run `mktemp` file and runs `lib/craft-log-run.mjs`, which computes every field
(`ts`/`project`/`commit`/`dirty`/`engineRevision`/`craftCommit`), names the file, appends the index
line and verifies the readback. All four engines go through that one path — the prompt itself is
built by `lib/run-logging.mjs` and inlined into each. A write that does not land is asserted, not
inferred: the agent returns `{ok, error}`, and the engine puts the loss in its own report. The shaping helpers are tested in `lib/run-record.mjs`; the workflow scripts inline verbatim
copies (the sandbox can't `import`). Standalone agents self-log via their `.md` Observability
section, suppressed when run as a workflow sub-agent.

### When a record is missing

The write can fail while the review itself is fine — a `craftRoot` that has moved, a dead logger
agent, a damaged store. So an absent record is **not** evidence that a review never ran. The generic
engine reports it instead of dying: every report it returns ends with a `⚠️ Telemetry lost` section
naming each write that did not land and why, and that section stays absent on a healthy run. Read the
report, not the store's silence — and note that only `review.js` does this today; the other engines
(`adversarial-review`, `rust-audit`, `triage-findings`) still lose a record without saying so.

### Launching an engine from a checkout

Installed as a plugin, `CLAUDE_PLUGIN_ROOT` is set and the logger resolves itself. Launched by
`scriptPath` from a checkout it is **not**, and the logger has no way to find `craft-log-run.mjs` —
so pass `craftRoot` (the craft checkout) in the workflow args, and `repo` when the engine's agents
are pointed at a different checkout than the session's cwd. Without `craftRoot` in that mode the run
still completes and reports its verdict; only the record is lost, and the report says so. The path
is never guessed from the working directory: that directory is the repository under review.

## Studying the data

```bash
# runs per handler
jq -s 'group_by(.name)[] | {name: .[0].name, runs: length}' ~/.craft/runs/index.jsonl
# everything that blocked
jq 'select(.verdict | test("Block"))' ~/.craft/runs/index.jsonl
# unused-crate verification refute rate over audit runs (from detail files)
jq -s '[.[] | select(.name=="rust-audit") | .verification | select(.!=null)]' ~/.craft/runs/*-workflow-rust-audit.json
```

Design rationale and accepted limitations were written up in a design spec that has since been
removed along with the rest of `docs/superpowers/`; recover it from git history if you need it
(`git log --diff-filter=D -- docs/superpowers/`). What still binds is on this page.

## Out of scope (v1)

Per-agent timing/token cost (only in raw `agent-*.jsonl` transcripts) and any analysis UI.
