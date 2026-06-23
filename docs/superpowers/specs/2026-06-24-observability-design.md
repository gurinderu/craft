# Observability for craft reviews — design

**Date:** 2026-06-24
**Status:** Approved (design); pending implementation plan.

## Problem

The craft review/audit machinery (`rust-audit` and `rust-review` workflows, plus the standalone
review agents) produces verdicts and findings, but leaves no durable, structured record of a run.
Raw agent transcripts (`agent-*.jsonl`) and the live `/workflows` view exist, but neither is
convenient to study after the fact. We want run records we can study later to improve prompts,
rubrics, the workflows themselves, and to track project health over time.

### Goals (all four wanted)

1. **Finding quality** — candidates found vs confirmed, verification refute rate, false-positive
   pressure by diff size — to tune prompts/rubrics.
2. **Cost/time** — how many agents, which models, which dimensions fired — to balance cost vs depth.
3. **History/trends** — an archive of verdicts and findings over time, per project.
4. **Workflow-improvement loop** — where agents fail / go NOT RUN, where verdicts diverge.

## Constraints

- **Workflow scripts run sandboxed**: no filesystem access, and `Date.now()`/`new Date()`/
  `Math.random()` throw. A script can compute structured data but cannot write files or read the
  clock. Therefore any persisted artifact must be written by an **agent** step (agents have Bash/Write).
- The script *does* have `budget.spent()` (output tokens spent this turn, shared pool — approximate).
- Per-agent timing and token cost live only in the raw transcript (`agent-*.jsonl`) — not reachable
  from the script. Out of scope for v1 (see below).

## Storage

Global per-user store (chosen over per-repo / wiki) so cross-project analysis and craft-improvement
work against a single dataset; every record carries `project` + `commit` so per-project trends are a
filter, not a separate store.

```
~/.craft/runs/
  index.jsonl                  # append-only, one compact line per run — trends/analysis
  <ts>-<kind>-<name>.json      # full per-run detail — deep dives
  README.md                    # format doc + jq examples
```

`ts` uses a filesystem-safe UTC form, e.g. `2026-06-24T14-30-00Z`. `index.jsonl` loads in one
command (`jq`, pandas) for trend analysis.

## Record schema (`schemaVersion: 1`)

A single schema with a `kind` discriminator.

**Common fields (every record):**

| field | type | notes |
|---|---|---|
| `schemaVersion` | int | `1` |
| `ts` | string | ISO-8601 UTC, stamped by the logging agent (`date -u`) |
| `kind` | string | `"workflow"` \| `"agent"` |
| `name` | string | `rust-audit` \| `rust-review` \| `rust-security-scanner` \| … |
| `project` | string | absolute path (`pwd`) of the audited repo |
| `commit` | string | short SHA (`git rev-parse --short HEAD`), `""` if not a repo |
| `dirty` | bool | uncommitted changes present |
| `verdict` | string | overall verdict |
| `findings` | object | `{ total, bySeverity: { Critical, High, Medium, Low, Info } }` |
| `nested` | bool | true if run as a sub-step of another workflow |
| `via` | string\|null | parent workflow name when nested (e.g. `"rust-audit"`), else null |

**`kind: "workflow"` adds:**

| field | type | notes |
|---|---|---|
| `scout` | object | `{ size, lenses, model(s), maxRounds, verifyVotes }` — whatever the workflow's scout produced |
| `dimensions` | array | `[{ dimension, verdict, findingCount, bySeverity }]` |
| `verification` | object | `{ candidates, confirmed, refuteRate }` — unused-crates and the review verify phase |
| `notRun` | array | dimension labels with no result |
| `outputTokens` | int | `budget.spent()` at end — approximate, shared pool |

**`kind: "agent"` adds:**

| field | type | notes |
|---|---|---|
| `toolsRun` | array | which tools actually ran (security/tests dimensions) |

## How workflows write records

At the end of each workflow (`rust-audit`, `rust-review`), the script assembles the record object
from what it knows (scout plan, per-dimension verdicts, finding counts, verification counters,
NOT RUN list, `budget.spent()`). It then dispatches a **dedicated cheap logger agent**
(haiku, effort low — pure mechanical IO) with that JSON in its prompt. The logger:

1. stamps `ts` (`date -u +%Y-%m-%dT%H-%M-%SZ` for the filename, ISO for the field),
2. fills `project` (`pwd`), `commit`/`dirty` (`git`),
3. `mkdir -p ~/.craft/runs`,
4. appends one compact line to `index.jsonl` via a single atomic `>>` write,
5. writes the full detail file `<ts>-<kind>-<name>.json`.

The workflow's returned report string is unchanged — logging is a side effect.

## Nesting and standalone agents

- Inside `rust-audit`, every `agentType` sub-call and the nested `rust-review` invocation get an
  appended prompt line: **"Observability: the workflow records this run — do not write your own
  record."** This prevents duplicate records from sub-agents.
- The nested `rust-review` writes its own workflow record with `nested: true, via: "rust-audit"`.
- Each standalone agent `.md` (`rust-reviewer`, `rust-security-scanner`, `rust-miri`,
  `rust-architecture-reviewer`) gets an **Observability** section: after issuing its verdict, append
  a `kind: "agent"` record — **unless** its prompt says the workflow owns observability.

## Out of scope (v1)

- **Per-agent timing/tokens** — only in raw `agent-*.jsonl`; a later, separate transcript-analysis
  pass can mine these.
- **Analysis tooling** — no new skill/command yet. The format is documented in
  `~/.craft/runs/README.md` (and the craft repo) with a couple of `jq` examples so studying the data
  is self-serve.

## Accepted limitations

- **End-of-run write**: a workflow that crashes before its logger step produces no record.
- **No exact parent id for nested runs**: nested `rust-review` records link to their parent audit by
  `(project, ts window)` rather than a precise id — the script has no clock or RNG to mint one.
- **`outputTokens` is approximate**: `budget.spent()` is a shared per-turn pool, not per-workflow.
