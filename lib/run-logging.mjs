// The ONE write path every engine uses to file its run record.
//
// WHY THIS EXISTS. Four workflow engines file run records, and until now only `review.js` wrote
// through the deterministic `lib/craft-log-run.mjs`. The other three handed a model a prose recipe:
// `mkdir -p ~/.craft/runs`, compute TS/PROJECT/COMMIT/DIRTY yourself, name the file, append the
// index line, write a README. Two things follow from that, and neither is a matter of prompt
// quality:
//
//   1. `engineRevision` is stamped exclusively inside `computedFields()` in craft-log-run.mjs, and
//      is deliberately absent from `indexProjection`. A prompt CANNOT produce it. `analyze-runs`
//      buckets a record without it into `r?` and `--engine latest` filters it out — so every record
//      a prose engine ever wrote was excluded from the pending measurements by construction.
//   2. The model computes the fields, so the fields are model variance. A live adversarial-review
//      run wrote an index line whose `project` pointed at `~/.craft/runs` itself with an empty
//      `commit`: step 1 of the recipe is a `mkdir -p` into the store, and the logger agent took its
//      `pwd` there. A second run of the same engine under the same recipe wrote a clean one.
//
// So the model is left with exactly one job — TRANSPORT — because the sandbox has no filesystem and
// nothing else can reach disk. The record goes into a quoted heredoc and the script owns every
// computed field, the filename, the index line and the readback.
//
// The sandbox cannot `import`, so these helpers reach the engines through a `craft-inline` fenced
// region (regenerated and byte-compared by `node lib/check-workflows.mjs`). Keeping the function
// NAMED `logRun` in each engine is load-bearing: `lib/workflow-version.mjs` derives "this workflow
// must carry a CRAFT_VERSION stamp" from a `/logRun\s*\(/` match on the source, so renaming or
// wrapping it would silently drop an engine from that gate.

// Asked of the logger agent so a failed write is ASSERTED, not inferred from a missing field.
export const LOGRUN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: {
    ok: { type: 'boolean', description: 'true only if the script ran and printed no craft-log-run FAILED line' },
    error: { type: 'string', description: 'when ok is false, the failing line verbatim; empty otherwise' },
  },
}

export function shq(s) { return `'${String(s ?? '').replace(/'/g, `'\\''`)}'` }

// Every logger command runs as `cd <reviewed repo> && node <logger>`, so a `:-.` fallback resolved
// AFTER the cd points at the REVIEWED repo, where the script is not — that lost every record to a
// silent "Cannot find module". Resolve the logger to an absolute path FIRST, into a variable, and
// only then change directory. `craftRoot` is passed when the engine is launched by scriptPath from
// a checkout (CLAUDE_PLUGIN_ROOT is unset then); as an installed plugin the env var is set for us.
// The `:-.` fallback is GONE, and that is a security fix, not tidying. It resolved before the `cd`,
// so `.` was the logger agent's starting directory — which, in the deployment this plugin is built
// for, is the repository under REVIEW. A reviewed repository shipping its own `lib/craft-log-run.mjs`
// would then be executed with the user's privileges by a workflow whose whole premise is that the
// reviewed repo is untrusted. Extraction would have carried that from one engine to four.
// It is emitted FIRST, before any staging: `${VAR:?}` is a hard abort in a non-interactive shell, so
// after the `cat` it killed the block before `rm -f` and left the whole record in TMPDIR — on exactly
// the path this loud failure was added for.
// A record that cannot be written is already a reported, non-fatal outcome (logRunOutcome →
// noteTelemetryLoss → the report), so refusing to guess a path costs a marker, not a run.
export function loggerPrelude(craftRoot) {
  if (craftRoot) return `CRAFT_LOGGER=${shq(craftRoot)}/lib/craft-log-run.mjs\n`
  return 'CRAFT_LOGGER="${CLAUDE_PLUGIN_ROOT:?craft-log-run FAILED: neither craftRoot nor CLAUDE_PLUGIN_ROOT is set — refusing to resolve the logger against the reviewed repository}/lib/craft-log-run.mjs"\n'
}

// The prompt that carries ONE record to disk. `command` is `write` (one-shot: detail file, verified
// readback, index line) or `finalize` (the same, plus folding in this run's phase checkpoints —
// review.js is the only engine that checkpoints). Nothing here asks the model to compute anything.
// THE STAGING FILE IS PER-RUN, AND THAT IS LOAD-BEARING. It used to be the fixed `/tmp/craft-rec.json`
// in one engine; extracting the prompt propagated that path to all four, which is three new ways to
// be wrong at once. (a) `cat >` follows a symlink, so any other local uid can pre-create that name
// pointing at a file this user owns and have the next run truncate it — an arbitrary-overwrite
// primitive on a shared or CI box, and `/tmp`'s sticky bit does not stop CREATING an entry. (b) The
// record holds every finding title, path and quoted snippet from the reviewed repo, and a default
// umask leaves it world-readable, never removed. (c) A fixed name carries no run id, while craft's
// own fan-out puts several runs in flight — rust-audit dispatches one nested review per changed crate
// through `parallel` — so between one agent's `cat >` and its own redirect another can overwrite the
// file: run A files run B's record under A's identity, the script succeeds, the readback verifies,
// `{ok:true}` comes back and NOTHING reports a loss. `mktemp` answers all three: unique name, 0600,
// created without following anything. The exit code is carried past the cleanup so a failed write
// still reports as one.
// `repo` steers the logger's `cd`, and THAT IS ALL IT STEERS. It is meaningful only for an engine
// whose review agents are pointed at the same checkout (review.js does that with REPO_DIRECTIVE);
// passed by an engine whose agents run in the session's cwd, it would file a record attributed to a
// repository the run never looked at — a lie in the one field the store is keyed by.
export function logRunPrompt({ record, craftRoot = '', repo = '', command = 'write', dir = '', rejoin = false } = {}) {
  const flags = `${dir ? `--dir ${shq(dir)} ` : ''}${!dir && rejoin ? '--rejoin ' : ''}`
  return `You are the craft observability logger. Persist ONE run record. This is mechanical IO — do not analyze, summarise, reformat or "clean up" any part of it.

Run exactly this:

\`\`\`
${loggerPrelude(craftRoot)}CRAFT_REC="$(mktemp "\${TMPDIR:-/tmp}/craft-rec.XXXXXX")"
cat > "$CRAFT_REC" <<'CRAFT_RECORD_EOF'
…RECORD below, byte for byte…
CRAFT_RECORD_EOF
cd ${shq(repo || '.')} && node "$CRAFT_LOGGER" ${command} ${flags}--project "$PWD" < "$CRAFT_REC"; CRAFT_RC=$?; rm -f "$CRAFT_REC"; exit $CRAFT_RC
\`\`\`

The script computes every field (ts, project, commit, dirty, engineRevision, craftCommit), names the file, appends the index line and verifies the readback. You compute NONE of that. In particular: do NOT \`mkdir\` the store, do NOT run \`date\`, \`pwd\` or \`git\` yourself, and do NOT append to index.jsonl by hand.

COPY THE RECORD VERBATIM into the quoted heredoc — it can be hundreds of KB (findings, ledger, dimensions), and re-emitting it from memory silently drops the big arrays. That is exactly how a completed review once persisted \`findings: 111\` with \`dimensions: []\` and no \`verification\`, destroying the per-lens telemetry the whole store exists for.

If the script prints a line starting \`craft-log-run FAILED\`, or the command itself fails (for example the logger path does not exist), return {"ok": false, "error": "<that line, or the shell error, verbatim>"} and stop — do NOT fall back to writing the file by hand. If it succeeded, return {"ok": true} — and if it ALSO printed a line starting \`craft-log-run WARNING\`, return {"ok": true, "error": "<that line verbatim>"}: the record landed, but something about the run directory did not, and the engine has to be able to say so. Best-effort either way: never error the run over this.

RECORD:
${JSON.stringify(record, null, 2)}`
}

// Copying a large record verbatim is not a low-effort task: haiku is fine for a gate-failed stub,
// but a full review record carries every finding plus the ledger, and the cheap model is where the
// silent truncation came from. Size the model to the payload.
export function logRunDispatch(record, { phase = '' } = {}) {
  const payloadKB = JSON.stringify(record).length / 1024
  const big = payloadKB > 24
  return {
    label: `log-run${big ? ` (${Math.round(payloadKB)}KB)` : ''}`,
    phase,
    schema: LOGRUN_SCHEMA,
    model: big ? 'sonnet' : 'haiku',
    effort: 'low',
  }
}

// A dead logger agent and a failed script are the same outcome — no record on disk — so both are
// reported. `ok !== true` rather than `!ok`: a malformed result is a write we cannot vouch for.
// The checkpoint prompt was a hand-copy of the record one, and copies drift the moment a fix lands
// on the original: the fixed staging path, the prelude ordering and the exit-code carry each had to
// be applied twice, and each time the second copy was the one nearly missed. Same builder, one
// difference — the checkpoint carries a phase and asks for the runDir back.
export function checkpointPrompt({ payload, craftRoot = '', repo = '', phase = '', dir = '', rejoin = false } = {}) {
  const flags = `--phase ${shq(phase)} ${dir ? `--dir ${shq(dir)} ` : ''}${!dir && rejoin ? '--rejoin ' : ''}`
  return `You are the craft observability logger writing ONE phase checkpoint. Mechanical IO — do not analyze.

Run exactly this, then return the runDir the script prints:

\`\`\`
${loggerPrelude(craftRoot)}CRAFT_REC="$(mktemp "\${TMPDIR:-/tmp}/craft-ckpt.XXXXXX")"
cat > "$CRAFT_REC" <<'CRAFT_RECORD_EOF'
…PAYLOAD below, byte for byte…
CRAFT_RECORD_EOF
cd ${shq(repo || '.')} && node "$CRAFT_LOGGER" checkpoint ${flags}--project "$PWD" < "$CRAFT_REC"; CRAFT_RC=$?; rm -f "$CRAFT_REC"; exit $CRAFT_RC
\`\`\`

The script owns naming, sequencing and every computed field. Copy PAYLOAD verbatim into the quoted heredoc. Best-effort: if it fails, report the error line and do NOT retry by writing files yourself.

PAYLOAD:
${JSON.stringify(payload, null, 2)}`
}

export function logRunOutcome(res) {
  // A WARNING is not a loss: the record IS on disk, and only the run DIRECTORY was refused or left
  // behind. Reporting it as a lost record would send a reader hunting for a file that exists, and a
  // marker that fires on a landed write is one people stop reading. But it must not vanish either —
  // the caller gets `ok: true` with a reason to surface.
  if (res && res.ok === true) return { ok: true, reason: String((res.error || '')).trim() }
  return { ok: false, reason: (res && (res.__threw || res.error)) || 'the logger agent returned no result' }
}

// For the agent calls whose FAILURE is not the caller's problem: the run record, the phase
// checkpoints, the prior-round read. They are bookkeeping — every other agent in these engines
// produces review content, so a throw there should stop the run. These must not: the record is
// written AFTER the report already exists in memory, so losing it to a bookkeeping write would
// throw away the whole run's product.
export function quietly(call) {
  return async (prompt, opts) => {
    try {
      return await call(prompt, opts)
    } catch (e) {
      return { __threw: String((e && e.message) || e) }
    }
  }
}
