// Test infrastructure: the craft binary's run-record writes as the JavaScript writer makes them — once the adapter the
// binary ran (realm @nick/craft, node #456), kept for the tests since the binary files through its own store writer
// (cli/crates/craft-store; #539). It builds the checkpoint payloads and the record (integrations/shared/cli-review-record.mjs) from the
// request the binary sends (cli/crates/craft-review/src/filing/wire.rs) and hands them to integrations/shared/craft-log-run.mjs in
// process: integrations/shared/store-parity.test.mjs writes the shared parity file from it, and integrations/shared/logger-replay.mjs replays a run's
// filing through it.
//
//   checkpoint --input <file> [--store <dir>]   the start's slice, or the slice of the phase the last step ended
//   finalize --input <file> [--store <dir>]     the record, folding the checkpoints in `dir`
//   publication --input <file>                  a finished run published on its PR after the fact: its sorting, memory
//                                               contradictions and PR comments written into the record already filed
//   develop-cycle --input <file> [--store <dir>]  one craft:develop cycle (`cycle`) filed as a record (craft runs develop-cycle)
//   sorting-choice --input <file> [--store <dir>] the reviewer's choice for a doubtful finding (craft runs sorting-choice)
//
// Its answer is the LAST line on stdout, one JSON object: a checkpoint's { phase, runDir } or { phase, error }, or
// { skipped: true } when no phase ended; the record's, a publication's and a post-hoc write's { ok, reason, file }.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { run as craftLogRun } from './craft-log-run.mjs'
import { cliRecord, publicationKept } from './cli-review-record.mjs'
import { finishedStep } from './cli-review-step.mjs'
import { runClock } from './cli-review-clock.mjs'
import { logRunOutcome } from './run-logging.mjs'
import { outputLines } from './script-main.mjs'
import { parseJson, parseJsonObject } from './json-object.mjs'

/** @typedef {import('./cli-review-clock.mjs').Told} Told */

// What craft-log-run prints for a filed record (`write`/`finalize`, or a proven retry).
const FILED_LINE = /^(?:wrote|already filed) (\/.+?\.json)(?: \(.*\))?$/gm

/** The last record file `text` says craft-log-run filed, '' when none. @param {string} text */
function filedIn(text) {
  let file = ''
  for (const m of text.matchAll(FILED_LINE)) file = String(m[1])
  return file
}
/** @typedef {import('./cli-review-clock.mjs').RuntimeStats} RuntimeStats */
/** @typedef {{ repo: string, craftVersion: string, session: string, dir: string, rejoin: boolean, steps: Told[] }} Common */

/**
 * The clock replayed over every step of a run segment as the binary kept them (cli/crates/craft-review/src/filing.rs),
 * so the binary's telemetry reads the figures the driver's own clock read: the phase the last step ended, and the
 * run's stats so far.
 * @param {Told[]} steps @returns {{ ended: { phase: string, minutes: number | null, agents: number } | null, stats: RuntimeStats }}
 */
function replay(steps) {
  const clock = runClock()
  /** @type {{ phase: string, minutes: number | null, agents: number } | null} */
  let ended = null
  for (const step of steps) {
    clock.tally(step.agents)
    ended = clock.observe(step)
  }
  return { ended, stats: clock.stats() }
}

/**
 * One phase checkpoint's payload: the start's with no figures, a phase's with what it cost and the head it read.
 * @param {string} craftVersion @param {string} phase @param {Record<string, unknown>} [figures]
 */
const checkpointPayload = (craftVersion, phase, figures = {}) => ({ kind: 'workflow', name: 'review', driver: 'cli', craftVersion, phase, ...figures })

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
  // The host the tasks run in rides on every checkpoint, so a run recovered from them is filed under it, not as
  // claude-code (integrations/shared/craft-log-run.mjs, recoveredBase).
  const runtime = text(req, 'runtime')
  const payload = withKept(runtime ? { ...figures, runtime } : figures, kept)
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
  const at = {
    craftVersion: c.craftVersion,
    depth: text(req, 'depth') || 'full',
    strict: req['strict'] === true,
    via: text(req, 'via') || null,
    outputTokens,
    runtime: text(req, 'runtime'),
  }
  const kept = keptIdentity(req, c.repo, req['retry'] === true)
  const record = { ...cliRecord({ ...read.step, runtimeStats: replay(c.steps).stats }, at), ...kept?.fields }
  const retry = req['retry'] === true ? ['--retry'] : []
  const r = await craftLogRun(['finalize', ...retry, ...loggerFlags(c, store, kept)], {}, c.repo, () => JSON.stringify(record))
  // The record's file, which the run's cost is enriched into (craft runs enrich-cost reads it off the step).
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

/**
 * The answer of a write made after a run: ok with the file and the line it said, or why it failed.
 * @param {import('./script-main.mjs').ScriptResult} r @param {string} file
 */
const said = (r, file) => (r.exitCode === 0 ? { ok: true, reason: r.stdout.at(-1) ?? '', file } : { ok: false, reason: r.stderr.join('; '), file: '' })

/**
 * One craft:develop cycle (`cycle`) filed as a record of `repo` — what `craft runs develop-cycle` writes from the binary.
 * @param {Record<string, unknown>} req @param {string} store
 */
async function developCycle(req, store) {
  const c = common(req)
  const r = await craftLogRun(['develop-cycle', ...loggerFlags(c, store, null)], {}, c.repo, () => JSON.stringify(req['cycle'] ?? {}))
  return said(r, (r.stdout.at(-1) ?? '').replace(/^wrote /, ''))
}

/**
 * The reviewer's choice for a doubtful finding (`n`, `choice`) into `recordFile`, or the newest review record of `repo`'s
 * branch with doubtful findings — what `craft runs sorting-choice` writes from the binary.
 * @param {Record<string, unknown>} req @param {string} store
 */
async function sortingChoice(req, store) {
  const c = common(req)
  const record = text(req, 'recordFile')
  const args = ['sorting-choice', '--n', String(req['n']), '--choice', text(req, 'choice'), ...(record ? ['--record', record] : [])]
  const r = await craftLogRun([...args, ...loggerFlags(c, store, null)], {}, c.repo, () => '')
  return said(r, / in (\/.+)$/.exec(r.stdout.at(-1) ?? '')?.[1] ?? '')
}

/** @type {Record<string, (req: Record<string, unknown>, store: string) => Promise<Record<string, unknown>>>} */
const COMMANDS = { checkpoint, finalize, publication, 'develop-cycle': developCycle, 'sorting-choice': sortingChoice }

/**
 * `<checkpoint|finalize|publication|develop-cycle|sorting-choice> --input <file> [--store <dir>]`: exit 0 with the answer as the last stdout line, 1 when the
 * input cannot be read, 2 on an unknown command.
 * @param {string[]} argv @returns {Promise<import('./script-main.mjs').ScriptResult>}
 */
export async function run(argv) {
  const o = outputLines()
  const write = Object.hasOwn(COMMANDS, String(argv[0])) ? COMMANDS[String(argv[0])] : undefined
  if (!write) {
    o.stderr.push('usage: <checkpoint|finalize|publication|develop-cycle|sorting-choice> --input <file> [--store <dir>]')
    return { exitCode: 2, ...o }
  }
  /** @type {Record<string, unknown>} */
  let req
  try {
    req = parseJsonObject(fs.readFileSync(flag(argv, 'input'), 'utf8'))
  } catch (e) {
    o.stderr.push(`binary-filing-replay: the input cannot be read: ${String(/** @type {{ message?: unknown }} */ (e).message ?? e ?? '')}`)
    return { exitCode: 1, ...o }
  }
  o.stdout.push(JSON.stringify(await write(req, flag(argv, 'store'))))
  return { exitCode: 0, ...o }
}
