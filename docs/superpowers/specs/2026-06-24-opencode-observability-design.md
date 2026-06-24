# opencode observability — design

**Date:** 2026-06-24
**Status:** Approved (design); pending implementation plan.
**Related:** `docs/superpowers/specs/2026-06-24-observability-design.md` (the Claude Code feature this extends to the opencode adapter).

## Problem

The Claude Code craft workflows and agents emit structured run records to `~/.craft/runs/`
(see `docs/observability.md`). The opencode adapter (`opencode/`) emits nothing, so runs done
through opencode are invisible to the same study/improvement loop. This extends observability to
the opencode `/rust-audit` and `/triage-findings` workflows, writing to the **same** store and
schema so both runtimes can be analysed together.

This is the first of two deferred opencode efforts; the deep port of the elastic `rust-review`
engine to opencode is explicitly out of scope here and remains a separate future spec.

## Key runtime facts (why this differs from the Claude Code design)

- The opencode plugin is a normal Bun process: `PluginCtx` exposes `$` (Bun shell) and the plugin
  already imports `node:fs`. **There is no sandbox** — the plugin can read the clock (`new Date()`)
  and write files directly. So, unlike Claude Code (which needs a logger *agent* because workflow
  scripts are sandboxed), opencode logs deterministically in TypeScript with **no logger agent**.
- opencode agents return **free text**, not schema-validated JSON. The orchestrator exposes only
  `fanOut` (concurrent + sequential-retry) and `runAgent` (one child session); `JobResult` is
  `{label, ok, text}`. Therefore the plugin can record *which* dimensions ran and parse an overall
  **verdict** from text, but cannot compute `findings.bySeverity` or token counts.

## Decisions (all confirmed)

1. **Plugin-side logging only.** The plugin writes one record per `/rust-audit` and
   `/triage-findings` run. The four hidden agents do **not** self-log (they are `hidden: true` and
   workflow-dispatched; standalone hidden-agent invocations going unlogged is a documented gap).
2. **Deterministic minimum fidelity.** Record only what is reliably known; do not parse severity
   breakdowns out of free text.
3. **Same store, same `schemaVersion: 1`**, with an explicit `runtime` discriminator added to
   **both** runtimes' records (Claude Code records gain `runtime: "claude-code"`; opencode records
   carry `runtime: "opencode"`).

## Record schema

Written to `~/.craft/runs/` (`index.jsonl` + `<ts>-<kind>-<name>.json`), `schemaVersion: 1`.

**opencode record (`kind: "workflow"`):**

| field | value |
|---|---|
| `schemaVersion` | `1` |
| `runtime` | `"opencode"` |
| `ts` | filesystem-safe UTC, `YYYY-MM-DDTHH-MM-SSZ`, from `new Date()` |
| `kind` | `"workflow"` |
| `name` | `"rust-audit"` \| `"triage-findings"` |
| `project` | `ctx.worktree || ctx.directory` |
| `commit` | `git rev-parse --short HEAD` via `ctx.$` (`""` if not a repo) |
| `dirty` | `git status --porcelain` non-empty |
| `verdict` | rust-audit: parsed from the synthesis text (Block/At-risk/UB-found→`Block`; Warning/Concerns→`Warning`; else `Approve`); triage: `""` |
| `dimensions` | `[{ dimension, ran }]` — one per `JobResult` (rust-audit: the audit dimensions; triage: one per validated finding). Include a per-dimension `verdict` when parseable from that job's text, else omit. |
| `notRun` | labels of `JobResult`s with `ok === false` |
| `findings` | `null` (no structured findings available) |
| `nested` | `false` |
| `via` | `null` |

`outputTokens` is omitted (not available in opencode). `index.jsonl` carries the projection
(adds `findingsTotal`, which is `null` here; includes `runtime`).

**Claude Code records** gain one field: `runtime: "claude-code"`. Everything else is unchanged.

## Mechanism

New module `opencode/plugin/run-record.mjs` (plain JS, **no opencode imports**, so it is
`node --test`-able exactly like `lib/run-record.mjs`):

- Pure: `parseVerdict(text) -> 'Block'|'Warning'|'Approve'` (single-text mirror of Claude Code's
  `worstVerdict` regex); `buildAuditRecord({results, baseRef, hasUnsafe}) -> record`;
  `buildTriageRecord({results, findingCount}) -> record`; `indexProjection(record) -> compact`
  (same projection as Claude Code's, **plus** `runtime`).
- IO: `writeRecord(ctx, record) -> Promise<void>` — stamps `ts` (`new Date()`), fills
  `project`/`commit`/`dirty` via `ctx.$` git calls, `mkdir -p ~/.craft/runs`, appends one compact
  line to `index.jsonl` (single atomic write), writes the detail file `<ts>-<kind>-<name>.json`.
  Best-effort: any failure is swallowed and logged, never failing the workflow run.

`opencode/plugin/rust-audit.ts` and `triage-findings.ts` import `./run-record.mjs` and call
`buildAuditRecord`/`buildTriageRecord` then `writeRecord` just before returning their report.
The install symlink keeps the intra-directory relative import intact.

## Claude Code changes (for the explicit `runtime` field)

- `lib/run-record.mjs`: `indexProjection` includes `runtime: r.runtime ?? null`; add a test case.
- `workflows/rust-audit.js`: `auditRecord` gains `runtime: 'claude-code'`; its inlined
  `indexProjection` copy is updated to match lib (kept byte-identical).
- `workflows/rust-review.js`: the `reviewRecord` factory gains `runtime: 'claude-code'`; its inlined
  `indexProjection` copy updated to match.
- `agents/*.md` (4): the self-log JSON line gains `"runtime":"claude-code"`.
- `docs/observability.md`: document the `runtime` field (and that opencode records are a subset:
  no `findings.bySeverity`, no `outputTokens`, `findings: null`).

## Testing

- `opencode/plugin/run-record.test.mjs` (`node --test`): cover `parseVerdict` (each verdict class),
  `buildAuditRecord` (dimensions/notRun/verdict assembly, `findings: null`, `runtime: "opencode"`),
  `buildTriageRecord`, and `indexProjection` (carries `runtime`, `findingsTotal: null`).
- `lib/run-record.test.mjs`: extend the `indexProjection` test to assert `runtime` passes through.
- `writeRecord`: deterministic shell/fs dry-run (mirrors the Claude Code logger dry-run) to confirm
  `ts` format, mkdir, atomic append, and detail-file round-trip on this machine.

## Out of scope / documented gaps

- Agent self-logging in opencode (hidden/workflow-only agents); a standalone hidden-agent run is
  not recorded.
- `findings.bySeverity` and `outputTokens` in opencode records (free-text agents; no token meter).
- The elastic `rust-review` engine port (separate future spec) — `/rust-audit`'s review dimension
  stays single-pass.

## Documentation updates

- `opencode/README.md`: replace the "No observability run-records" parity caveat with a short
  "Observability" subsection describing what is written and the deterministic-minimum fidelity.
- `docs/observability.md`: add the `runtime` field and a one-line note that opencode records are a
  subset.
