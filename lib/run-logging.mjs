// The ONE write path every engine uses to file its run record.
//
// WHY THIS EXISTS. Four workflow engines file run records, and until now only `review.js` wrote
// through the deterministic `lib/craft-log-run.mjs`. The other three handed a model a prose recipe:
// `mkdir -p ~/.craft/runs`, compute TS/PROJECT/COMMIT/DIRTY yourself, name the file, append the
// index line, write a README. Two things follow from that, and neither is a matter of prompt
// quality:
//
//   1. `engineRevision` is stamped only by the script — on records inside `computedFields()`, on
//      checkpoints inside `writeCheckpoint()` (both in craft-log-run.mjs) — and
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
// The engines import these helpers and esbuild bundles them in (lib/build-engines.mjs). Keeping the function
// NAMED `logRun` in each engine is load-bearing: `lib/workflow-version.mjs` derives "this workflow
// must carry a CRAFT_VERSION stamp" from a `/logRun\s*\(/` match on the source, so renaming or
// wrapping it would silently drop an engine from that gate.

import { cutRecord, RECORD_PART_PHASE } from './record-parts.mjs'
import { recordNonce, attemptFlag, TRANSCRIPT_MISS } from './record-nonce.mjs'
import { SERVICE_AGENT_TYPE } from './service-agent.mjs'
import { pluginScriptPrelude, shq } from './plugin-script.mjs'

// Re-exported: every engine module took them from here before they moved to lib/plugin-script.mjs.
export { pluginScriptPrelude, shq }

// Asked of the logger agent so a failed write is ASSERTED, not inferred from a missing field.
export const LOGRUN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: {
    ok: { type: 'boolean', description: 'true only if the script ran and printed no craft-log-run FAILED line' },
    // The lines the logger model relays from the script's output — still the model's relay: the sandbox cannot
    // read the script's streams. The engine reads a warning only off a relayed line that opens with the script's
    // marker, ignores `error` under ok:true, and no longer asks the model to compose a warning: a free-text
    // `error` under ok:true was relayed as one, and a model that paraphrased the success line into it raised
    // "Telemetry incomplete" over a complete record (realm @nick/craft, node #409). Optional, so a model that
    // omits it is not a missed structured answer; missing, it carries no warning.
    output: {
      type: 'array',
      items: { type: 'string' },
      description: 'every line the command printed (stdout and stderr), verbatim and in order — copy them, never summarise or reword them',
    },
    error: { type: 'string', description: 'when ok is false, the failing line (or the shell error) verbatim; empty otherwise' },
  },
}

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
/**
 * @param {string | undefined} craftRoot
 * @param {string} [version]
 * @param {string} [repo]
 */
export function loggerPrelude(craftRoot, version = '', repo = '') {
  // The refusal names WHICH check rejected each candidate (realm @nick/craft, node #382): a single fixed
  // sentence left a refusal with craftRoot passed unexplained — an empty CRAFT_REPO and a missing file
  // read the same. printf, not echo: a path may hold a backslash, which some shells' echo interprets.
  return `${pluginScriptPrelude(craftRoot, version, repo, 'lib/craft-log-run.mjs', 'CRAFT_LOGGER')}[ -n "\${CRAFT_LOGGER:-}" ] || { printf '%s\\n' "craft-log-run FAILED: no usable logger — \${CRAFT_LOGGER_WHY}refusing to resolve against the reviewed repository"; exit 1; }
`
}

// The craft version a record or checkpoint payload claims, as text ('' when it claims none).
/** @param {unknown} payload @returns {string} */
export function payloadVersion(payload) {
  return String((payload && typeof payload === 'object' ? /** @type {{ craftVersion?: unknown }} */ (payload).craftVersion : undefined) ?? '')
}

// The logger flags both prompts share: `--dir`, `--rejoin` and the shell-expanded session id, each
// independent of the others (see logRunPrompt below), with the trailing space the command line needs.
/** @param {string} dir @param {boolean} rejoin @returns {string} */
export function runDirFlags(dir, rejoin) {
  return `${dir ? `--dir ${shq(dir)} ` : ''}${rejoin ? '--rejoin ' : ''}\${CLAUDE_CODE_SESSION_ID:+--session "$CLAUDE_CODE_SESSION_ID"} `
}

// The engine's revision a SECOND time, on the command line the engine composes itself (realm
// @nick/craft, node #114). It decides which fingerprint basis a later round reads this run under, and
// the payload it also rides in is re-emitted by the logger agent — so craft-log-run files it only when
// the two copies agree; one altered copy files an unknown basis, never a wrong one. Emitted only for a
// payload that stamps an integer revision: an engine that stamps no basis sends no flag.
/** @param {unknown} payload @returns {string} */
export function engineRevisionFlag(payload) {
  const rev = payload && typeof payload === 'object' ? /** @type {{ workflowEngineRevision?: unknown }} */ (payload).workflowEngineRevision : undefined
  return Number.isInteger(rev) ? `--engine-revision ${String(rev)} ` : ''
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
// whose agents are pointed at the same checkout (review.js and triage-findings.js do, lib/repo-arg.mjs);
// passed by an engine whose agents run in the session's cwd, it would file a record attributed to a
// repository the run never looked at — a lie in the one field the store is keyed by.
// FIRST the script reads the record from the logger agent's own transcript, found by the prompt's nonce, and
// the model copies nothing (realm @nick/craft, node #429). Only a `TRANSCRIPT-MISS` sends it to the heredoc
// below — and with `fallback: false` not even there: the engine then sends the record in parts instead.
// `attempt` numbers this dispatch of the record, so each prompt carries its own nonce (lib/record-nonce.mjs).
/** @param {{ record?: unknown, craftRoot?: string, repo?: string, command?: string, dir?: string, rejoin?: boolean, retry?: boolean, fallback?: boolean, attempt?: number }} [opts] */
export function logRunPrompt({ record, craftRoot = '', repo = '', command = 'write', dir = '', rejoin = false, retry = false, fallback, attempt } = {}) {
  // The version comes off the RECORD rather than from a parameter of its own: it is already there,
  // and taking it from anywhere else lets the copy the logger is looked up by drift from the version
  // the record claims to be — which would file a record describing a run some other build made.
  const version = payloadVersion(record)
  // `${CLAUDE_CODE_SESSION_ID:+--session "..."}` is shell-expanded INSIDE the script the logger agent
  // runs, never composed by the model — the whole point (see the header note on the payload-copy
  // incident this file already documents). `:+` is deliberate over `:-`: it fires only when the var
  // is BOTH set and non-empty, so an unset session id degrades to no flag at all rather than the
  // logger receiving the literal string "" and treating it as a real (empty) session id.
  // `--dir` and `--rejoin` are INDEPENDENT, and the `!dir &&` that used to gate the second one was a
  // silent contract break. review.js finalized with `{ dir: runDir, rejoin: checkpointFailed }`, so
  // any run that had a runDir at all sent the directory and swallowed the rejoin — the CLI then read
  // `rejoin: false` for a directory that may well have been ADOPTED by an earlier `--rejoin`
  // checkpoint. What depends on the flag arriving is the OWNERSHIP proof: it is the engine's own
  // statement that its `runDir` may have been adopted, and nothing downstream can reconstruct that
  // from the directory alone. It is NOT a fallback for a refused `--dir` — `finalizeRun` refuses the
  // rejoin search outright in that case (see its `target` comment), because the single candidate a
  // garbled sibling finds is its neighbour's LIVE directory.
  // `--retry` marks the engine's own re-dispatch: only then does the store take an identical payload for one it filed.
  const flags = `${retry ? '--retry ' : ''}${attemptFlag(attempt)}${runDirFlags(dir, rejoin)}`
  const nonce = recordNonce(record, { command, retry, attempt })
  const prelude = loggerPrelude(craftRoot, version, repo)
  const node = `cd ${shq(repo || '.')} && node "$CRAFT_LOGGER" ${command} ${engineRevisionFlag(record)}${flags}--project "$PWD"`
  const step2 = recordStep2(prelude, node, fallback)
  return `You are the craft observability logger. Persist ONE run record. This is mechanical IO — do not analyze, summarise, reformat or "clean up" any part of it.

NONCE: ${nonce}

Step 1 — run exactly this. The script reads the RECORD at the end of this prompt from your own transcript (it finds this prompt by the NONCE above), so you copy nothing:

\`\`\`
${prelude}${node} --from-transcript ${nonce}
\`\`\`

${step2}

The script computes every field (ts, project, commit, dirty, engineRevision, craftCommit, and — reading the working copy with git — branch and head, whose values in the record below are only a fallback for what git cannot resolve), names the file, appends the index line and verifies the readback. You compute NONE of that. In particular: do NOT \`mkdir\` the store, do NOT run \`date\`, \`pwd\` or \`git\` yourself, and do NOT append to index.jsonl by hand.

Whatever happens, return every line the commands you ran printed — stdout and stderr, verbatim, in order — as "output". Do not reword, summarise or add to them: the engine reads them as the script's own words.

If the script prints a line starting \`craft-log-run FAILED\`, or the command itself fails (for example the logger path does not exist), return {"ok": false, "output": [<the printed lines>], "error": "<that line, or the shell error, verbatim>"} and stop — do NOT fall back to writing the file by hand. If it succeeded — it prints \`wrote <file>\`, or \`already filed <file>\` when an earlier attempt filed this same record — return {"ok": true, "output": [<the printed lines>]}. Best-effort either way: never error the run over this.

RECORD:
${JSON.stringify(record, null, 2)}`
}

const NO_HEREDOC = `If step 1 prints a line starting \`${TRANSCRIPT_MISS}\`, it wrote nothing: do NOT copy the record anywhere and do NOT write it by hand — return {"ok": false, "output": [<the printed lines>], "error": "<that line, verbatim>"} and stop. The engine sends the record another way.`

// Step 2 of the record prompt: the heredoc copy, run only on step 1's TRANSCRIPT-MISS — unless `fallback` is
// false, when the engine sends a missed record in parts instead (realm @nick/craft, node #396).
/** @param {string} prelude @param {string} node @param {boolean | undefined} fallback @returns {string} */
function recordStep2(prelude, node, fallback) {
  if (fallback === false) return NO_HEREDOC
  return `Step 2 — ONLY if step 1 printed a line starting \`${TRANSCRIPT_MISS}\` (it wrote nothing), run this instead; otherwise do NOT run it:

\`\`\`
${prelude}CRAFT_REC="$(mktemp "\${TMPDIR:-/tmp}/craft-rec.XXXXXX")"
cat > "$CRAFT_REC" <<'CRAFT_RECORD_EOF'
…RECORD below, byte for byte…
CRAFT_RECORD_EOF
${node} < "$CRAFT_REC"; CRAFT_RC=$?; rm -f "$CRAFT_REC"; exit $CRAFT_RC
\`\`\`

In step 2, COPY THE RECORD VERBATIM into the quoted heredoc — it can be hundreds of KB (findings, ledger, dimensions), and re-emitting it from memory silently drops the big arrays. That is exactly how a completed review once persisted \`findings: 111\` with \`dimensions: []\` and no \`verification\`, destroying the per-lens telemetry the whole store exists for.`
}

// Copying a large record verbatim is not a low-effort task: haiku is fine for a gate-failed stub,
// but a full review record carries every finding plus the ledger, and the cheap model is where the
// silent truncation came from. Size the model to the payload.
// The options are typed as the sandbox's `agent()` takes them — `effort` a literal, not a string — so an
// engine passes them on as they are.
/**
 * @param {unknown} record
 * @param {{ phase?: string }} [opts]
 * @returns {{ label: string, phase: string, schema: typeof LOGRUN_SCHEMA, model: 'sonnet' | 'haiku', effort: 'low' }}
 */
export function logRunDispatch(record, { phase: phaseTitle = '' } = {}) {
  const payloadKB = JSON.stringify(record).length / 1024
  const big = payloadKB > 24
  return {
    label: `log-run${big ? ` (${Math.round(payloadKB)}KB)` : ''}`,
    phase: phaseTitle,
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
/** @param {{ payload?: unknown, craftRoot?: string, repo?: string, phase?: string, dir?: string, rejoin?: boolean, attempt?: number }} [opts] */
export function checkpointPrompt({ payload, craftRoot = '', repo = '', phase: phaseTitle = '', dir = '', rejoin = false, attempt } = {}) {
  // DERIVED from the payload, never passed alongside it. As a plumbing argument with a silent ''
  // default it was forgettable, and it was duly forgotten at one of three call sites — deleting it
  // there left every gate green while that engine's checkpoints went back to refusing exactly as
  // before the fix, with finalize and prior-round succeeding beside them. A checkpoint describes the
  // same run as the record, so the version belongs on the payload anyway.
  const version = payloadVersion(payload)
  // See the matching note in logRunPrompt above: shell-expanded, never model-composed, and `:+`
  // degrades an unset/empty session id to no flag rather than to the literal string "".
  // Independent of `--dir`, for the reason spelled out in `logRunPrompt` above.
  const flags = `--phase ${shq(phaseTitle)} ${engineRevisionFlag(payload)}${attemptFlag(attempt)}${runDirFlags(dir, rejoin)}`
  const nonce = recordNonce(payload, { command: 'checkpoint', phase: phaseTitle, attempt })
  const prelude = loggerPrelude(craftRoot, version, repo)
  const node = `cd ${shq(repo || '.')} && node "$CRAFT_LOGGER" checkpoint ${flags}--project "$PWD"`
  // Transcript first, heredoc only on a miss, as in logRunPrompt above (realm @nick/craft, node #429).
  return `You are the craft observability logger writing ONE phase checkpoint. Mechanical IO — do not analyze.

NONCE: ${nonce}

Step 1 — run exactly this, then return the runDir the script prints. The script reads the PAYLOAD at the end of this prompt from your own transcript (it finds this prompt by the NONCE above), so you copy nothing:

\`\`\`
${prelude}${node} --from-transcript ${nonce}
\`\`\`

Step 2 — ONLY if step 1 printed a line starting \`${TRANSCRIPT_MISS}\` (it wrote nothing), run this instead and return the runDir it prints; otherwise do NOT run it:

\`\`\`
${prelude}CRAFT_REC="$(mktemp "\${TMPDIR:-/tmp}/craft-ckpt.XXXXXX")"
cat > "$CRAFT_REC" <<'CRAFT_RECORD_EOF'
…PAYLOAD below, byte for byte…
CRAFT_RECORD_EOF
${node} < "$CRAFT_REC"; CRAFT_RC=$?; rm -f "$CRAFT_REC"; exit $CRAFT_RC
\`\`\`

The script owns naming, sequencing and every computed field. In step 2, copy PAYLOAD verbatim into the quoted heredoc. Best-effort: if it fails, report the error line and do NOT retry by writing files yourself.

PAYLOAD:
${JSON.stringify(payload, null, 2)}`
}

// The markers craft-log-run opens its own lines with (lib/craft-log-run.mjs).
const LOGGER_WARNING = 'craft-log-run WARNING:'
const LOGGER_FAILED = 'craft-log-run FAILED'

/**
 * @param {unknown} res harness result of the logger agent (model output), or a quiet call's `{ __threw }`
 * @returns {{ ok: boolean, reason: string }}
 */
export function logRunOutcome(res) {
  const r = res && typeof res === 'object' ? /** @type {{ ok?: unknown, output?: unknown, error?: unknown, __threw?: unknown }} */ (res) : null
  const said = scriptLines(r?.output)
  const failed = said.filter(l => l.startsWith(LOGGER_FAILED))
  // A WARNING is not a loss: the record IS on disk, and only the run DIRECTORY was refused or left
  // behind. Reporting it as a lost record would send a reader hunting for a file that exists, and a
  // marker that fires on a landed write is one people stop reading. But it must not vanish either —
  // the caller gets `ok: true` with a reason to surface. The reason is only the relayed `output` lines that
  // open with the script's WARNING marker; `error` under ok:true is ignored. A relayed line opening with the
  // FAILED marker outranks the model's ok:true. The relay is the model's (see LOGRUN_SCHEMA).
  if (r?.ok === true && !failed.length) return { ok: true, reason: said.filter(l => l.startsWith(LOGGER_WARNING)).join('; ') }
  return { ok: false, reason: lossReason(r, failed) }
}

// Why a write did not land: the harness's throw, else a relayed FAILED line, else the model's `error`.
/** @param {{ error?: unknown, __threw?: unknown } | null} r @param {string[]} failed @returns {string} */
function lossReason(r, failed) {
  return String((r && (r.__threw || failed.join('; ') || r.error)) || 'the logger agent returned no result')
}

// The lines a logger agent relayed, trimmed; anything but an array of strings relays none.
/** @param {unknown} output @returns {string[]} */
function scriptLines(output) {
  if (!Array.isArray(output)) return []
  return output.flatMap(l =>
    typeof l === 'string'
      ? l
          .split('\n')
          .map(x => x.trim())
          .filter(Boolean)
      : [],
  )
}

// For the agent calls whose FAILURE is not the caller's problem: the run record, the phase
// checkpoints, the prior-round read. They are bookkeeping — every other agent in these engines
// produces review content, so a throw there should stop the run. These must not: the record is
// written AFTER the report already exists in memory, so losing it to a bookkeeping write would
// throw away the whole run's product.
/**
 * @template P, O, R
 * @param {(prompt: P, opts: O) => Promise<R>} call a harness agent callback
 * @returns {(prompt: P, opts: O) => Promise<R | { __threw: string }>}
 */
export function quietly(call) {
  return async (prompt, opts) => {
    try {
      return await call(prompt, opts)
    } catch (e) {
      return { __threw: String((e && /** @type {{ message?: unknown }} */ (e).message) || e) }
    }
  }
}

// The Claude Code harness's message, observed: "agent({schema}): subagent completed without calling StructuredOutput (after in-conversation nudge)".
export const MISSED_STRUCTURED_OUTPUT = 'without calling StructuredOutput'

// A quiet call that threw because the agent finished without returning its structured answer.
/** @param {unknown} res @returns {boolean} */
export function missedStructuredOutput(res) {
  const threw = res && typeof res === 'object' ? /** @type {{ __threw?: unknown }} */ (res).__threw : undefined
  return String(threw ?? '').includes(MISSED_STRUCTURED_OUTPUT)
}

// The logger agent failed as an agent: no answer, a throw, or a refusal that is not the script's own
// FAILED line (a script that ran and refused would refuse the same payload again).
/** @param {unknown} res @returns {boolean} */
export function loggerAgentDied(res) {
  const outcome = logRunOutcome(res)
  return !outcome.ok && !/craft-log-run FAILED/.test(outcome.reason)
}

// The run-record writer each engine binds as its `logRun` — one body for all four. What differs
// between engines is BOUND, not copied: the agent call (review's retries underneath `quietly`, the
// others' plain `agent`), the phase the write is dispatched under, where the logger writes (`target`,
// read at each call: review finalizes into a `runDir` that only exists once a checkpoint has run),
// what is stamped onto every record (`prepare`: review's fingerprint basis), and how a loss is noted
// (review's one noteTelemetryLoss for every bookkeeping write; telemetryLossNoter for the others).
// A lost record NEVER fails the run: it is noted, and the engine renders the note where a human reads.
// The returned function must still be bound to the NAME `logRun` in the engine — see the header.
// The record goes as ONE call whose script reads it from the logger agent's own transcript, whatever its size
// (realm @nick/craft, node #429). A record past one call's size is not offered the heredoc in that call: on a
// TRANSCRIPT-MISS it goes down in parts, each a checkpoint into the run's directory, and the logger then
// finalizes a header that names them (realm @nick/craft, node #396). No part landed — the whole record in one
// call with the heredoc behind the transcript, as a record within one call's size goes from the start.
/**
 * @template O
 * @param {object} o
 * @param {(prompt: string, opts: LoggerCall) => Promise<O>} o.call  a `quietly`-wrapped agent callback
 * @param {string} o.phase
 * @param {() => LoggerTarget} o.target
 * @param {(what: string, why: string, landed: boolean) => void} o.noteLoss
 * @param {(record: Record<string, unknown>) => Record<string, unknown>} [o.prepare]
 * @param {boolean} [o.serviceAgent]  each write's first ask on the service agent, its own re-ask on the default type
 * @returns {(record: Record<string, unknown>) => Promise<void>}
 */
export function makeRunLogger({ call: again, phase: phaseTitle, target, noteLoss, prepare = record => record, serviceAgent = false }) {
  // The re-ask is numbered and marked `--retry`, so the store answers `already filed` for a write the first ask
  // did file: it, not a rerun of the same prompt, is the service agent's fallback to the default type
  // (lib/service-agent.mjs, realm @nick/craft, node #397).
  /** @type {Asks<O>} */
  const ask = { first: serviceAgent ? (prompt, opts) => again(prompt, { ...opts, agentType: SERVICE_AGENT_TYPE }) : again, again }
  return async recordIn => {
    const record = prepare(recordIn)
    const to = target()
    // Every dispatch of this record is numbered, so no two of its prompts share a nonce and none of them
    // misses its own transcript for another's (lib/record-nonce.mjs).
    let attempt = 0
    /** @param {LoggerAt} at @param {LoggerCall} dispatch */
    const send = (at, dispatch) => sendRecord(ask, at, dispatch, () => attempt++)
    const { header, parts } = cutRecord(record)
    let res = parts.length
      ? // The model copies nothing on this call, so the cheap one carries any size.
        await send({ ...to, record, fallback: false }, { ...logRunDispatch(record, { phase: phaseTitle }), model: 'haiku' })
      : null
    // Not filed by the transcript call for any reason — a miss, a dead agent on both tries, a refusal — the
    // record goes in parts, as before the transcript path (realm @nick/craft, nodes #429, #396).
    if (!res || !logRunOutcome(res).ok) {
      const partsDir = parts.length ? await writeRecordParts(parts, record, { ask, phase: phaseTitle, to, noteLoss }) : ''
      const at = partsDir ? { ...to, command: 'finalize', dir: partsDir, record: header } : { ...to, record }
      res = await send(at, logRunDispatch(at.record, { phase: phaseTitle }))
    }
    const landed = logRunOutcome(res)
    if (!landed.ok) noteLoss('the run record', landed.reason, false)
    // The record landed and the script still had something to say — a run directory refused or left
    // behind. Not a lost record, so it must not read as one, but not silence either.
    else if (landed.reason) noteLoss('the run directory (the record itself landed)', landed.reason, true)
  }
}

// One record dispatch, re-dispatched once when its agent did not answer; `next` numbers each prompt.
/**
 * @template O
 * @param {Asks<O>} ask @param {LoggerAt} at @param {LoggerCall} dispatch
 * @param {() => number} next
 */
async function sendRecord({ first, again: call }, at, dispatch, next) {
  const res = await first(logRunPrompt({ ...at, attempt: next() }), dispatch)
  // A miss with no heredoc behind it is the script's own answer, not a dead agent: asked again, the same
  // transcript misses again, and the caller sends the record in parts.
  if (at.fallback === false && transcriptMissed(res)) return res
  // Once, for a missed structured answer: the script most likely ran, and `--retry` lets the store
  // answer the identical payload `already filed` (realm @nick/craft, node #246). Once too for a logger
  // AGENT that died or threw without the script's own FAILED line (realm @nick/craft, node #299): a fresh
  // one on the stronger model gets the same write, marked `--retry` so a first attempt that did file it
  // is answered `already filed`, not filed twice. This covers a one-off logger death only: under an
  // account-wide usage limit the re-dispatch fails the same way, and the record stays in `.partial` for
  // `craft-log-run recover`.
  if (missedStructuredOutput(res)) return call(logRunPrompt({ ...at, retry: true, attempt: next() }), dispatch)
  if (loggerAgentDied(res)) return call(logRunPrompt({ ...at, retry: true, attempt: next() }), { ...dispatch, model: 'sonnet' })
  return res
}

// The logger's answer says its script found no sure record in the agent's transcript (realm @nick/craft, node #429).
/** @param {unknown} res @returns {boolean} */
export function transcriptMissed(res) {
  const r = res && typeof res === 'object' ? /** @type {{ output?: unknown, error?: unknown }} */ (res) : null
  return [...scriptLines(r?.output), String(r?.error ?? '')].some(l => l.includes(TRANSCRIPT_MISS))
}

/** @typedef {LoggerTarget & { record: unknown, retry?: boolean, fallback?: boolean }} LoggerAt */
/** @typedef {{ craftRoot?: string, repo?: string, command?: string, dir?: string, rejoin?: boolean }} LoggerTarget */
/** @typedef {Omit<ReturnType<typeof logRunDispatch>, 'schema'> & { schema: typeof LOGRUN_SCHEMA | typeof PART_SCHEMA, agentType?: string }} LoggerCall */
/** @template O @typedef {{ first: (prompt: string, opts: LoggerCall) => Promise<O>, again: (prompt: string, opts: LoggerCall) => Promise<O> }} Asks  a write's first ask, and its re-ask */

// What a record part's checkpoint answers: the directory it went into.
const PART_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['runDir'],
  properties: {
    runDir: { type: 'string', description: 'the runDir the script printed; empty string if it failed' },
    error: { type: 'string', description: 'when runDir is empty, the failing line verbatim; empty otherwise' },
  },
}

// Each part as a checkpoint into the run's directory — the one the engine has, else the one the first landed
// part made (rejoining when the engine armed it). A part that lands elsewhere or not at all is noted, and
// finalize files the record short with a warning; two lost in a row end the parts. The directory, '' when
// no part landed.
/**
 * @template O
 * @param {ReturnType<typeof cutRecord>['parts']} parts @param {Record<string, unknown>} record
 * @param {{ ask: Asks<O>, phase: string, to: LoggerTarget, noteLoss: (what: string, why: string, landed: boolean) => void }} o
 * @returns {Promise<string>}
 */
async function writeRecordParts(parts, record, { ask, phase: phaseTitle, to, noteLoss }) {
  let dir = to.dir || ''
  let landed = 0,
    missed = 0
  for (const part of parts) {
    const name = `${RECORD_PART_PHASE}-${String(part.recordPart.index).padStart(2, '0')}`
    const at = { payload: { ...partHead(record), ...part }, ...partTarget(to), phase: name, dir, rejoin: !dir && !!to.rejoin }
    const res = await writeRecordPart(ask, attempt => checkpointPrompt({ ...at, attempt }), {
      label: `checkpoint:${name}`,
      phase: phaseTitle,
      schema: PART_SCHEMA,
      model: 'haiku',
      effort: 'low',
    })
    const got = partDir(res)
    if (got && (!dir || got === dir)) {
      dir = got
      landed++
      missed = 0
      continue
    }
    noteLoss(`record part '${name}'`, partLossReason(res, got, dir), false)
    // Two parts in a row lost: the logger is not landing anything, and the rest would only spend calls.
    if (++missed === 2) break
  }
  return landed ? dir : ''
}

// One part's checkpoint, asked once more when its logger agent died, as the record is: finalize keeps one
// copy of an index, so a second copy costs nothing. The second ask is numbered, so its nonce is its own.
/** @template O @param {Asks<O>} ask @param {(attempt: number) => string} prompt @param {LoggerCall} opts */
async function writeRecordPart({ first, again }, prompt, opts) {
  const res = await first(prompt(0), opts)
  return !partDir(res) && (missedStructuredOutput(res) || loggerAgentDied(res)) ? again(prompt(1), opts) : res
}

// What every part carries besides its entries: what names its directory and finds its logger, the engine's
// revision (a checkpoint's basis) and the round (what `recover` reads off a directory).
/** @param {Record<string, unknown>} record @returns {Record<string, unknown>} */
function partHead(record) {
  /** @type {Record<string, unknown>} */
  const head = {}
  for (const k of ['kind', 'name', 'craftVersion', 'workflowEngineRevision', 'round']) if (record[k] !== undefined) head[k] = record[k]
  return head
}

/** @param {LoggerTarget} to @returns {{ craftRoot: string, repo: string }} */
function partTarget(to) {
  return { craftRoot: to.craftRoot ?? '', repo: to.repo ?? '' }
}

/** @param {unknown} res @param {string} got @param {string} dir @returns {string} */
function partLossReason(res, got, dir) {
  return got ? `the logger wrote it to ${got}, not the run's ${dir}` : logRunOutcome(res).reason
}

/** @param {unknown} res @returns {string} */
function partDir(res) {
  const r = /** @type {{ runDir?: unknown } | null} */ (res && typeof res === 'object' ? res : null)
  return typeof r?.runDir === 'string' ? r.runDir : ''
}

// The loss note of the engines that keep no other bookkeeping writes: every loss is kept for the
// report, and logged — a landed record under its own prefix, never as a lost one.
/**
 * @param {string[]} lost
 * @param {(line: string) => void} say
 * @returns {(what: string, why: string, landed: boolean) => void}
 */
export function telemetryLossNoter(lost, say) {
  return (what, why, landed) => {
    lost.push(`${what} — ${why}`)
    say(landed ? `⚠️ telemetry: ${why}` : `⚠️ telemetry lost: ${what} — ${why}`)
  }
}
