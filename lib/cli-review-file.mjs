// The run-record adapter the `craft` binary runs (cli/crates/craft-review/src/filing.rs; realm @nick/craft, node
// #456): the binary files a cli-review run's telemetry itself, and this script is the only JavaScript between it and
// the one write path, lib/craft-log-run.mjs, called in process. It builds what the logger agents used to carry — the
// checkpoint payloads and the record (lib/cli-review-record.mjs), the phase figures and runtimeStats replayed by the
// driver's own clock over the steps the binary kept (lib/cli-review-clock.mjs), the finished step read as the driver
// reads it (lib/cli-review-step.mjs) — so the record's shape has one implementation, not a second one in Rust.
//
//   checkpoint --input <file> [--store <dir>]   the start's slice, or the slice of the phase the last step ended
//   finalize --input <file> [--store <dir>]     the record, folding the checkpoints in `dir`
//
// The input is one JSON object the binary wrote: { repo, craftVersion, session, dir, rejoin, steps, head, start } for a
// checkpoint, { repo, craftVersion, session, dir, rejoin, retry, steps, step, depth, strict, via, outputTokens } for the
// record. Its answer is the LAST line on stdout, one JSON object (craft-log-run's own lines may come before it): a
// checkpoint's { phase, runDir } or { phase, error }, or { skipped: true } when no phase ended; the record's { ok, reason,
// file }, file the record's path in the store ('' when none landed).
import fs from 'node:fs'
import { run as craftLogRun } from './craft-log-run.mjs'
import { checkpointPayload, cliRecord } from './cli-review-record.mjs'
import { finishedStep } from './cli-review-step.mjs'
import { replay } from './cli-review-clock.mjs'
import { logRunOutcome } from './run-logging.mjs'
import { filedIn } from './run-agents.mjs'
import { parseJsonObject } from './json-object.mjs'
import { outputLines, runIfMain } from './script-main.mjs'

/** @typedef {import('./cli-review-clock.mjs').Told} Told */
/** @typedef {{ repo: string, craftVersion: string, session: string, dir: string, rejoin: boolean, steps: Told[] }} Common */

/** The value of `--<name>`, '' when absent. @param {string[]} argv @param {string} name */
const flag = (argv, name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? String(argv[i + 1] ?? '') : ''
}

/** @param {Record<string, unknown>} req @param {string} k */
const text = (req, k) => (typeof req[k] === 'string' ? /** @type {string} */ (req[k]) : '')

/** The fields every write takes. @param {Record<string, unknown>} req @returns {Common} */
const common = req => ({
  repo: text(req, 'repo'), craftVersion: text(req, 'craftVersion'), session: text(req, 'session'), dir: text(req, 'dir'),
  rejoin: req['rejoin'] === true, steps: Array.isArray(req['steps']) ? req['steps'] : [],
})

/**
 * The logger's flags for this run: the directory, the rejoin, the session and the reviewed repository, and the store
 * when one was named. @param {Common} c @param {string} store @returns {string[]}
 */
const loggerFlags = (c, store) => [
  ...(c.dir ? ['--dir', c.dir] : []), ...(c.rejoin ? ['--rejoin'] : []), ...(c.session ? ['--session', c.session] : []),
  '--project', c.repo, ...(store ? ['--store', store] : []),
]

/**
 * The start's checkpoint, or the one of the phase the last step ended, with what it cost.
 * @param {Record<string, unknown>} req @param {string} store
 */
async function checkpoint(req, store) {
  const c = common(req)
  const ended = req['start'] === true ? null : replay(c.steps).ended
  if (req['start'] !== true && !ended) return { skipped: true }
  const phase = ended ? ended.phase : 'start'
  const payload = ended ? checkpointPayload(c.craftVersion, phase, { minutes: ended.minutes, agents: ended.agents, head: text(req, 'head') }) : checkpointPayload(c.craftVersion, phase)
  const r = await craftLogRun(['checkpoint', '--phase', phase, ...loggerFlags(c, store)], {}, c.repo, () => JSON.stringify(payload))
  if (r.exitCode !== 0) return { phase, error: r.stderr.join('; ') || `craft-log-run exited ${r.exitCode}` }
  return { phase, runDir: String(JSON.parse(String(r.stdout.at(-1))).runDir ?? '') }
}

/**
 * The record of the finished step, its runtimeStats replayed over the steps; `--retry` when an earlier attempt may
 * have filed it, so the store answers `already filed` rather than file it twice.
 * @param {Record<string, unknown>} req @param {string} store
 */
async function finalize(req, store) {
  const c = common(req)
  const read = finishedStep(/** @type {Record<string, unknown>} */ (req['step'] ?? {}))
  if ('error' in read) return { ok: false, reason: `the finished step cannot be read: ${read.error}` }
  const outputTokens = typeof req['outputTokens'] === 'number' ? req['outputTokens'] : null
  const at = { craftVersion: c.craftVersion, depth: text(req, 'depth') || 'full', strict: req['strict'] === true, via: text(req, 'via') || null, outputTokens }
  const record = cliRecord({ ...read.step, runtimeStats: replay(c.steps).stats }, at)
  const retry = req['retry'] === true ? ['--retry'] : []
  const r = await craftLogRun(['finalize', ...retry, ...loggerFlags(c, store)], {}, c.repo, () => JSON.stringify(record))
  // The record's file, which the run's cost is enriched into (lib/run-agents.mjs reads it off the step).
  return { ...logRunOutcome({ ok: r.exitCode === 0, output: [...r.stdout, ...r.stderr] }), file: filedIn(r.stdout.join('\n')) }
}

/** @type {Record<string, (req: Record<string, unknown>, store: string) => Promise<Record<string, unknown>>>} */
const COMMANDS = { checkpoint, finalize }

/**
 * `<checkpoint|finalize> --input <file> [--store <dir>]`: exit 0 with the answer as the last stdout line, 1 when the
 * input cannot be read, 2 on an unknown command.
 * @param {string[]} argv @returns {Promise<import('./script-main.mjs').ScriptResult>}
 */
export async function run(argv) {
  const o = outputLines()
  const write = Object.hasOwn(COMMANDS, String(argv[0])) ? COMMANDS[String(argv[0])] : undefined
  if (!write) {
    o.stderr.push('usage: cli-review-file.mjs <checkpoint|finalize> --input <file> [--store <dir>]')
    return { exitCode: 2, ...o }
  }
  /** @type {Record<string, unknown>} */
  let req
  try {
    req = parseJsonObject(fs.readFileSync(flag(argv, 'input'), 'utf8'))
  } catch (e) {
    o.stderr.push(`cli-review-file: the input cannot be read: ${String(/** @type {Error} */ (e).message ?? e)}`)
    return { exitCode: 1, ...o }
  }
  o.stdout.push(JSON.stringify(await write(req, flag(argv, 'store'))))
  return { exitCode: 0, ...o }
}

await runIfMain(import.meta.url, run)
