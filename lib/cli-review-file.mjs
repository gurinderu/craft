// The run-record adapter the `craft` binary runs (cli/crates/craft-review/src/filing.rs; realm @nick/craft, node
// #456): the binary files a review run's telemetry itself, and this script is the only JavaScript between it and
// the one write path, lib/craft-log-run.mjs, called in process. It builds what the logger agents used to carry — the
// checkpoint payloads and the record (lib/cli-review-record.mjs), the phase figures and runtimeStats replayed by the
// driver's own clock over the steps the binary kept (lib/cli-review-clock.mjs), the finished step read as the driver
// reads it (lib/cli-review-step.mjs) — so the record's shape has one implementation, not a second one in Rust.
//
//   checkpoint --input <file> [--store <dir>]   the start's slice, or the slice of the phase the last step ended
//   finalize --input <file> [--store <dir>]     the record, folding the checkpoints in `dir`
//   publication --input <file>                  a finished run published on its PR after the fact (`craft review
//                                               comment`): its sorting, memory contradictions and PR comments
//                                               written into the record already filed, `recordFile`
//
// The input is one JSON object the binary wrote: { repo, craftVersion, session, dir, rejoin, steps, head, gitDir, branch,
// dirty, start } for a checkpoint, { repo, craftVersion, session, dir, rejoin, retry, steps, step, head, gitDir, branch,
// dirty, depth, strict, via, outputTokens } for the record, { …the same common fields, step, recordFile } for a publication — gitDir, branch and dirty the run's identity, read only
// when the reviewed working copy `repo` is gone. Its answer is the LAST line on stdout, one JSON object (craft-log-run's own lines may come before it): a
// checkpoint's { phase, runDir } or { phase, error }, or { skipped: true } when no phase ended; the record's { ok, reason,
// file }, file the record's path in the store ('' when none landed); a publication's { ok, reason, file }, reason on
// success naming the reviewer's choices it dropped.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { run as craftLogRun } from './craft-log-run.mjs'
import { checkpointPayload, cliRecord, publicationKept } from './cli-review-record.mjs'
import { finishedStep } from './cli-review-step.mjs'
import { replay } from './cli-review-clock.mjs'
import { logRunOutcome } from './run-logging.mjs'
import { filedIn } from './run-agents.mjs'
import { outputLines, runIfMain } from './script-main.mjs'
import { parseJson, parseJsonObject } from './json-object.mjs'

/** @typedef {import('./cli-review-clock.mjs').Told} Told */
/** @typedef {{ repo: string, craftVersion: string, session: string, dir: string, rejoin: boolean, steps: Told[] }} Common */

/** The value of `--<name>`, '' when absent. @param {string[]} argv @param {string} name */
const flag = (argv, name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? (argv[i + 1] ?? '') : ''
}

/** @param {Record<string, unknown>} req @param {string} k */
const text = (req, k) => (typeof req[k] === 'string' ? /** @type {string} */ (req[k]) : '')

/** The steps the request carries, as the binary printed them: not checked here. @param {unknown} v @returns {Told[]} */
const toldSteps = v => {
  /** @type {unknown[]} */
  const list = Array.isArray(v) ? v : []
  return /** @type {Told[]} */ (list)
}

/** The fields every write takes. @param {Record<string, unknown>} req @returns {Common} */
const common = req => ({
  repo: text(req, 'repo'),
  craftVersion: text(req, 'craftVersion'),
  session: text(req, 'session'),
  dir: text(req, 'dir'),
  rejoin: req['rejoin'] === true,
  steps: toldSteps(req['steps']),
})

/**
 * The run's identity as the binary kept it when the run started (cli/crates/craft-review/src/filing/kept.rs, Ctx): the
 * repository's shared git directory, which keys the write as the live run's was, and the branch, head, short commit and
 * dirtiness the live run read off its working copy. Used for a re-file (`refile`: a record filed again, whose checkout
 * may have moved on since) and for any write once the working copy is gone; null for a live write — the logger then
 * reads them itself, as ever — and when the run kept no git directory, or that is gone too.
 * @param {Record<string, unknown>} req @param {string} repo @param {boolean} refile
 * @returns {{ gitDir: string, fields: Record<string, unknown> } | null}
 */
function keptIdentity(req, repo, refile) {
  const gitDir = text(req, 'gitDir')
  if (!gitDir || !fs.existsSync(gitDir) || !(refile || !repo || !fs.existsSync(repo))) return null
  const head = text(req, 'head')
  const branch = typeof req['branch'] === 'string' && req['branch'] ? { branch: req['branch'] } : {}
  return { gitDir, fields: { ...branch, ...(head ? { head, commit: shortCommit(gitDir, head) } : {}), dirty: req['dirty'] === true } }
}

/**
 * A checkpoint's payload stamped with the run's kept identity, which its ownership proof is read from, as the run had
 * it; as it stands without one. @param {Record<string, unknown>} payload @param {ReturnType<typeof keptIdentity>} kept
 */
const withKept = (payload, kept) => (kept ? { ...payload, branch: kept.fields['branch'] ?? '', head: kept.fields['head'] ?? '' } : payload)

/** `head` abbreviated as git abbreviates it in the repository at `gitDir`, '' when git cannot. @param {string} gitDir @param {string} head */
function shortCommit(gitDir, head) {
  try {
    return execFileSync('git', ['--git-dir', gitDir, 'rev-parse', '--short', head], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

/**
 * The logger's flags for this run: the directory, the rejoin, the session and the reviewed repository — keyed through
 * the git directory the run kept, its identity taken from the payload, when there is one (keptIdentity) — and the store
 * when one was named.
 * @param {Common} c @param {string} store @param {ReturnType<typeof keptIdentity>} kept @returns {string[]}
 */
const loggerFlags = (c, store, kept) => [
  ...(c.dir ? ['--dir', c.dir] : []),
  ...(c.rejoin ? ['--rejoin'] : []),
  ...(c.session ? ['--session', c.session] : []),
  ...(kept ? ['--project', kept.gitDir, '--identity-from-record'] : ['--project', c.repo]),
  ...(store ? ['--store', store] : []),
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
  const kept = keptIdentity(req, c.repo, false)
  const figures = ended
    ? checkpointPayload(c.craftVersion, phase, { minutes: ended.minutes, agents: ended.agents, head: text(req, 'head') })
    : checkpointPayload(c.craftVersion, phase)
  const payload = withKept(figures, kept)
  const r = await craftLogRun(['checkpoint', '--phase', phase, ...loggerFlags(c, store, kept)], {}, c.repo, () => JSON.stringify(payload))
  if (r.exitCode !== 0) return { phase, error: r.stderr.join('; ') || `craft-log-run exited ${r.exitCode}` }
  /** @type {{ runDir?: unknown }} */
  const said = parseJson(String(r.stdout.at(-1)))
  return { phase, runDir: String(said.runDir ?? '') }
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
  const kept = keptIdentity(req, c.repo, req['retry'] === true)
  const record = { ...cliRecord({ ...read.step, runtimeStats: replay(c.steps).stats }, at), ...kept?.fields }
  const retry = req['retry'] === true ? ['--retry'] : []
  const r = await craftLogRun(['finalize', ...retry, ...loggerFlags(c, store, kept)], {}, c.repo, () => JSON.stringify(record))
  // The record's file, which the run's cost is enriched into (lib/run-agents.mjs reads it off the step).
  return { ...logRunOutcome({ ok: r.exitCode === 0, output: [...r.stdout, ...r.stderr] }), file: filedIn(r.stdout.join('\n')) }
}

/**
 * The publication of a finished step written into the record already filed (`recordFile`), in the record's own shape.
 * Run from the binary's filing directory: the reviewed checkout may be gone, and the record names its file.
 * @param {Record<string, unknown>} req
 */
async function publication(req) {
  const file = text(req, 'recordFile')
  if (!file) return { ok: false, reason: 'no record file was named', file: '' }
  const read = finishedStep(/** @type {Record<string, unknown>} */ (req['step'] ?? {}))
  if ('error' in read) return { ok: false, reason: `the finished step cannot be read: ${read.error}`, file: '' }
  const r = await craftLogRun(['publication', '--record', file], {}, process.cwd(), () => JSON.stringify(publicationKept(read.step)))
  if (r.exitCode !== 0) return { ok: false, reason: r.stderr.join('; ') || `craft-log-run exited ${r.exitCode}`, file: '' }
  // A recorded choice whose finding the new sorting no longer lists is dropped: said, the publication still landed.
  return { ok: true, reason: r.stdout.find(l => l.startsWith('dropped the choices')) ?? '', file }
}

/** @type {Record<string, (req: Record<string, unknown>, store: string) => Promise<Record<string, unknown>>>} */
const COMMANDS = { checkpoint, finalize, publication }

/**
 * `<checkpoint|finalize|publication> --input <file> [--store <dir>]`: exit 0 with the answer as the last stdout line, 1 when the
 * input cannot be read, 2 on an unknown command.
 * @param {string[]} argv @returns {Promise<import('./script-main.mjs').ScriptResult>}
 */
export async function run(argv) {
  const o = outputLines()
  const write = Object.hasOwn(COMMANDS, String(argv[0])) ? COMMANDS[String(argv[0])] : undefined
  if (!write) {
    o.stderr.push('usage: cli-review-file.mjs <checkpoint|finalize|publication> --input <file> [--store <dir>]')
    return { exitCode: 2, ...o }
  }
  /** @type {Record<string, unknown>} */
  let req
  try {
    req = parseJsonObject(fs.readFileSync(flag(argv, 'input'), 'utf8'))
  } catch (e) {
    o.stderr.push(`cli-review-file: the input cannot be read: ${String(/** @type {{ message?: unknown }} */ (e).message ?? e ?? '')}`)
    return { exitCode: 1, ...o }
  }
  o.stdout.push(JSON.stringify(await write(req, flag(argv, 'store'))))
  return { exitCode: 0, ...o }
}

await runIfMain(import.meta.url, run)
