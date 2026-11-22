# craft run records

- `index.jsonl` — one compact JSON line per run; load with `jq -s`.
- `<ts>-<kind>-<name>.json` — full per-run detail.
- `.partial/<run>/` — phase checkpoints of a run still in flight. `node integrations/shared/craft-log-run.mjs recover`
  promotes any that never finalized into `partial: true` records; a directory written to within the last
  6 h (`--stale-after <min>`) is kept, its run may be live (`--force` removes it anyway).
- `.filing-intents/<detail>.json` — a write in flight; every write replays these first. One whose detail
  was rewritten since (a crash, then another writer) is a `filing conflict`: the intent stays, the newer
  detail is never overwritten, writes to other records go on, a write to that record refuses, and the
  warning names both files. The intent's `record` may be the run's only copy: never just delete it.
  To keep it, move the detail aside and `jq -j .record <intent> > <detail>`; the next write completes
  the intent. To keep the detail, save that record elsewhere, then delete the intent.

Common fields: schemaVersion, engineRevision, ts, kind (workflow|agent), name, project, commit, dirty, verdict,
findings{total,bySeverity}, nested, via. Workflows add scout/dimensions/verification/notRun/outputTokens;
agents add toolsRun. A record with `partial: true` did NOT finish — never average it in with complete runs.
On such a record `engineRevision` is the RECOVERING craft's; `runEngineRevision`, when present, is the
revision the stopped run's own checkpoints attest to (the highest of one fingerprint basis).
`workflowEngineRevision` (on a review record and its checkpoints) is the revision of the ENGINE that
computed the fingerprints — what a later round decides their basis by; `engineRevision` is the logger's.
`workflowEngineRevisionDisputed` replaces it when the copy the logger agent carried disagreed with the
`--engine-revision` the engine put on the command line: such a record or slice establishes no basis.

An optional `cost{output,input,cacheRead,cacheWrite,total,agents,source,rule}` (with a `skipped` count
added only when a transcript could not be read, and `slice{index,of,tail?}` when the record is one of
several a run filed) is folded in AFTER the run by
`craft runs enrich-cost --run-id <wf_id>` (or `--run-dir <d> --record <f>`) — the REAL per-agent spend summed
from the run's agent-*.jsonl transcripts (cacheRead is ~99% of it). `outputTokens` above is only the
harness pool, under 1% of real cost: the Workflow budget's `spent()` from the engine's start to the write —
the run's own share, since `spent()` counts the whole session (an older record may hold that session
total). Absent until a run is enriched. A cost without `rule: "per-message"`
was summed per transcript line and overstates the run ~1.8x: re-run enrich-cost on it while its transcripts exist.

    jq -s 'group_by(.name)[]|{name:.[0].name,runs:length}' index.jsonl
    jq 'select(.verdict|test("Block"))' index.jsonl
