// The review engine's telemetry (src/review.js): the phase checkpoints, the final record, and every write
// that was attempted and did not land, which the report then names.
import { checkpointPrompt, makeRunLogger, telemetryLossNoter } from './run-logging.mjs'
import { ENGINE_REVISION } from './run-record.mjs'

/**
 * @template T
 * @typedef {import('./review-schemas.mjs').Schema<T>} Schema
 */
/**
 * @typedef {import('./review-schemas.mjs').CheckpointAnswer} CheckpointAnswer
 * @typedef {ReturnType<typeof import('./review-run-agent.mjs').makeReviewAgent>} Dispatch
 */

/**
 * The run's telemetry: `startHead` is set once detect answers; `rejoinArmed` is read by the ledger's shards.
 * @param {{ logLine: (message: string) => void, ragentQuietly: Dispatch['ragentQuietly'], splitThrew: Dispatch['splitThrew'], craftRootArg: string, repoArg: string, craftVersion: string }} deps
 */
export function makeRunTelemetry({ logLine, ragentQuietly, splitThrew, craftRootArg, repoArg, craftVersion }) {
// A phase checkpoint. Small by construction — counts, per-lens yields, the gate verdict — because
// its job is to survive the run, not to duplicate the final record early. `runDir` is threaded back
// out of the first call so every later checkpoint lands in the same directory without the sandbox
// needing a clock or a run id (it has neither).
// Telemetry is written by an agent shelling out to lib/craft-log-run.mjs, so it fails for reasons the
// run itself survives: a craftRoot that no longer exists, a dead logger agent, a damaged store. That
// failure used to be pure silence — the review finished, the store stayed empty, and an empty store
// is indistinguishable from "this review was never run" (realm @nick/craft, node #24).
// The choice is deliberate and recorded (realm @nick/craft, node #34): a lost record NEVER fails the
// run. Killing a three-hour review over a bookkeeping write would teach everyone to ignore the very
// marker this exists to raise. It is reported instead, in the report a human actually reads.
/** @type {string[]} */
const telemetryLost = []
/** @param {string} what @param {unknown} [why] */
function noteTelemetryLoss(what, why) {
  const line = `${what}${why ? ` — ${why}` : ''}`
  telemetryLost.push(line)
  logLine(`⚠️ telemetry lost: ${line}`)
}
// ---- the one write path (shared with every other record-filing engine) ----
// lib/run-logging.mjs, imported as run-record.mjs is. The ledger's own survival path, the shard cutter, is
// lib/ledger-shards.mjs, where it is linted and unit-tested; what the final record says about its ledger once
// the shards hold it is lib/ledger-in-shards.mjs (realm @nick/craft, node #245).

/** @type {Schema<CheckpointAnswer>} */
const CHECKPOINT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['runDir'],
  properties: {
    runDir: { type: 'string', description: 'the runDir the script printed; empty string if it failed' },
    error: { type: 'string', description: 'when runDir is empty, the failing line verbatim; when the script printed a craft-log-run WARNING line, that line verbatim; empty otherwise' },
  },
}
let runDir = ''
// The head detect saw, set once detect answers; every checkpoint claims it (see checkpoint below).
let startHead = ''
let checkpointFailed = false
let rejoinArmed = false
// ARMED, not merely "something failed". `checkpointFailed` says a checkpoint died; this says the run
// went on to ASK the logger to rejoin — `!runDir && checkpointFailed`, the only state in which a
// directory can be adopted. Finalize used the coarser flag, so a run whose first checkpoint minted
// its directory and whose third died declared an adoption that never happened: the CLI then dropped
// the `ownDir` shortcut, read a mid-review branch move as "not this run's directory", and left the
// run's own phases unfolded. Sticky, because an adoption is not undone by later checkpoints
// succeeding — once a directory MIGHT be someone else's, it stays might-be for the finalize proof.
// Resolves true only when the slice landed in the directory this run already had and asked for.
/** @param {string} phaseTitle @param {Record<string, unknown>} payloadIn @param {string} group @returns {Promise<boolean>} */
async function checkpoint(phaseTitle, payloadIn, group) {
  // kind/name are what the checkpoint DIRECTORY is named after, and `recover` parses them back out of
  // that name to rebuild a dead run's identity. A payload without them produced a real
  // `…Z-unknown-unknown` directory on the first live run — recoverable, but recovered as a run of
  // nothing. They belong on every slice, not just the final record.
  // craftVersion rides on every slice: it is what the checkpoint's own logger lookup derives its
  // version from, and a slice that cannot say which build wrote it is a slice `recover` cannot place.
  // workflowEngineRevision: THIS engine's revision, the side that computes the fingerprints — what a
  // later round decides their basis by (realm @nick/craft #111). Last, so no payload key shadows it.
  // startHead: the head detect saw before scout, gate or any lens read the tree. The logger stamps the slice's
  // own `head` from git, minutes later; it keys a push verdict to that head only when the two agree
  // (lib/craft-log-run.mjs, reviewedTree), so a fix committed in between is never taken as reviewed.
  const payload = { kind: 'workflow', name: 'review', craftVersion, ...payloadIn, startHead, workflowEngineRevision: ENGINE_REVISION }
  // ragent does NOT catch a budget-exceeded throw (see its comment), and agent() throws for harness
  // reasons too — so a rejection, not just a null, is a real outcome here. It has to land in the same
  // place as every other failed write: the report. Letting it propagate would abort the whole review
  // over a bookkeeping write, which is exactly what this whole path exists to prevent.
  const asked = runDir
  const armRejoin = !runDir && checkpointFailed
  if (armRejoin) rejoinArmed = true
  const { answer: res, threw } = splitThrew(await ragentQuietly(
    checkpointPrompt({ payload, craftRoot: craftRootArg, repo: repoArg, phase: phaseTitle, dir: runDir, rejoin: armRejoin }),
    { label: `checkpoint:${phaseTitle}`, phase: group, schema: CHECKPOINT_SCHEMA, model: 'haiku', effort: 'low' },
  ))
  if (res?.runDir) return tookRunDir(phaseTitle, asked, res.runDir)
  // Remember it: with no runDir to thread, every later checkpoint would mint a directory of its
  // own and this run would fragment into orphan partials that `recover` promotes as unrelated
  // half-runs. `--rejoin` lets the script re-enter the directory this run already has. It is opt-in
  // for a reason — asking for it unconditionally would make a SECOND, concurrent review adopt this
  // one's directory, and concurrent reviews on one machine are ordinary.
  checkpointFailed = true
  noteTelemetryLoss(`phase checkpoint '${phaseTitle}'`, threw || res?.error || 'the logger agent returned no runDir')
  return false
}
// The directory a landed checkpoint returned, taken as the run's; true when it is the one the run asked for.
/** @param {string} phaseTitle @param {string} asked @param {string} returned @returns {boolean} */
function tookRunDir(phaseTitle, asked, returned) {
  // A refused `--dir` does not fail the checkpoint: the script MINTS a fresh directory, prints a
  // WARNING on stderr and returns a perfectly valid runDir on stdout. Taking it silently strands
  // every slice written into the directory we asked for — finalize folds only the new one, its
  // `kept` warning cannot fire (the old directory was never its target), and the report calls the
  // run clean. The engine can see this without trusting the model to relay stderr: we know which
  // directory we asked for, so a different one coming back IS the refusal.
  if (asked && returned !== asked) {
    noteTelemetryLoss(`phase checkpoint '${phaseTitle}'`, `the logger minted ${returned} instead of the run's own ${asked} — earlier phase slices there will not be folded`)
  }
  runDir = returned
  return !!asked && returned === asked
}

// Persisting the record is deterministic work, and it is now done by lib/craft-log-run.mjs. The model
// is left in the loop only because the sandbox cannot reach a filesystem at all — its entire job is a
// quoted heredoc into the script. It no longer computes ts/project/commit/dirty, chooses the filename,
// hand-appends the index or hand-verifies the readback; that recipe is what once persisted a completed
// review as `dimensions: [], verification: null`. Fewer decisions in the prompt is the whole fix.
// The write itself is the one every engine binds (lib/run-logging.mjs, makeRunLogger); what is
// review's own is bound here.
const logRun = makeRunLogger({
  // ragent underneath `quietly`, so the retry-once behaviour still applies to the record write.
  call: ragentQuietly,
  phase: 'Synthesize',
  // `finalize`, not `write`: this is the one engine that checkpoints, so the script folds this run's
  // phase slices into the record it writes. Read at each call — `runDir` and `rejoinArmed` move as
  // the checkpoints run.
  target: () => ({ craftRoot: craftRootArg, repo: repoArg, command: 'finalize', dir: runDir, rejoin: rejoinArmed }),
  // Every review record — the early exits too, not only reviewRecord() — says which engine computed its
  // fingerprints: a later round decides their basis by this (realm @nick/craft #111). Last, so no
  // caller's field shadows it.
  prepare: recordIn => ({ ...recordIn, workflowEngineRevision: ENGINE_REVISION }),
  // Into the same telemetryLost list the checkpoints and the prior-round read note into, but through
  // the shared note: a record that landed with its run directory refused is logged as landed, never
  // as lost (realm @nick/craft #39). makeRunLogger always hands it a non-empty reason, so the line kept
  // for the report is the one noteTelemetryLoss would keep.
  noteLoss: telemetryLossNoter(telemetryLost, logLine),
})
return {
  telemetryLost, noteTelemetryLoss, checkpoint, logRun,
  get rejoinArmed() { return rejoinArmed },
  get runDir() { return runDir },
  get startHead() { return startHead },
  set startHead(v) { startHead = v },
}
}
