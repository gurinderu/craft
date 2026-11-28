// The Claude Code driver of the CLI's step protocol (integrations/claude-code/src/review.js; realm @nick/craft, node #453): the `craft`
// binary decides what a review needs and starts no agent, this driver runs the agents each step hands out and
// hands their answers back. It holds no review logic: what to ask, of which model, in which shape, and what the
// answers mean are all the binary's. The sandbox reads no file and spawns no process (#134), so a service agent runs
// the binary and returns its small JSON verbatim; the prompts, schemas and answers themselves travel as files in the
// run directory — each task's agent reads its prompt file and writes its answer file — so no model copies them.
// The binary files the run's telemetry itself — a checkpoint as each of its phases ends, the record when the run
// finishes, written by its own store writer byte for byte as integrations/shared/craft-log-run.mjs writes them (realm @nick/craft, nodes
// #456, #539) — told by each submit what only the driver sees: the task agents dispatched and the output tokens spent. The
// driver files only the record of a run the binary never finished (integrations/shared/cli-review-record.mjs); it gets the binary
// and the plugin root as every kind's driver does (integrations/shared/cli-step-binary.mjs).
import { binAndRoot } from './cli-step-binary.mjs'
import { servicePrompt, serveWith, serviceOf } from './cli-step-service.mjs'
import { makeDefaultTypeFallback } from './service-agent.mjs'
import { taskRunner } from './cli-review-task.mjs'
import { cliRecorder } from './cli-review-record.mjs'
import { finishedAnswer, resumeHint, stoppedAnswer, unreadAnswer } from './cli-review-verdict.mjs'
import { runClock } from './cli-review-clock.mjs'
import { VALUE_REFUSED_CLASS, argumentProblem, viaName } from './cli-review-keys.mjs'
import { readOptions } from './cli-review-options.mjs'
import { MAX_ROUNDS, briefStatusCommand, commentCommand, startCommand, statusCommand, submitCommand } from './cli-review-commands.mjs'
import { STOPPED, absolutePath, argumentRefused, isObject, readStep } from './cli-review-step.mjs'
import { briefOf, endedOf, standingOf, statusUnreadable } from './cli-review-ended.mjs'
import { harnessRefused, harnessStop } from './cli-review-refusal.mjs'
import { gateAnswer, gateCommand, gateShell } from './cli-review-gate.mjs'
import { dispatchTasks, stepRounds } from './cli-step-loop.mjs'
import { pageCommand, readPaged, unreadRun } from './cli-review-paged.mjs'
import { telemetryLostSection } from './review-coverage.mjs'
import { argumentRefusal } from './run-record.mjs'
import { normalizeArgs } from './workflow-args.mjs'
import { runBudget } from './run-budget.mjs'
import { UNKNOWN_COMPLETION, recoveryFailure, stopCause, stopNotRun, stopRead } from './cli-review-stop.mjs'

/** @typedef {import('./cli-review-options.mjs').Options} Options */
/** @typedef {import('./cli-review-step.mjs').Step} Step */
/** @typedef {import('./cli-review-step.mjs').Finished} Finished */
/** @typedef {import('./cli-step-service.mjs').Serve} Serve */
/** @typedef {(prompt: string, opts?: Record<string, unknown>) => Promise<unknown>} Agent */
/** @typedef {{ args: unknown, agent: Agent, parallel: <T>(thunks: Array<() => Promise<T>>) => Promise<Array<T | null>>, phase: (title: string) => void, log: (message: string) => void, budget?: { spent: () => number | null } }} Sandbox */

// The delimiter of the heredoc that hands the binary the launcher's records on its stdin.
const PRIOR_DECISIONS_EOF = 'CRAFT_PRIOR_DECISIONS'
// The start fetches the source of each integration point the reviewer's profile names (craft init) on its first
// run at that revision, within its own budget of 240 s (cli/crates/craft-review/src/sources/runner.rs), and beside it
// runs the mechanical gate's tools — clippy, semgrep, nix flake check, statix, deadnix — within theirs of 300 s
// (cli/crates/craft-review/src/gate.rs): longer than a Bash call's default two minutes allow, and inside this timeout.
// A submit may file the run's telemetry — a stopped part's record, a checkpoint and the record, each waiting at most 45 s
// on the store's index lock (cli/crates/craft-store/src/lock.rs) — and post the findings on the PR within 75 s
// (cli/crates/craft-review/src/publish/gh.rs): past a Bash call's default two minutes, so seven with headroom.
const SUBMIT_TIMEOUT = "in one Bash call with a timeout of 420000 ms (it may file the run's telemetry and post review comments on the PR)"
const START_TIMEOUT =
  "in one Bash call with a timeout of 600000 ms (it may fetch the source of each integration point the reviewer's profile names, and may build and lint the branch for the mechanical gate)"

/**
 * The start (integrations/shared/cli-review-commands.mjs), the launcher's records handed on its stdin through a quoted heredoc.
 * @param {Options} o @param {import('./cli-review-commands.mjs').Where} where @param {string} version  the engine's craft version
 * @returns {string}
 */
function startPrompt(o, where, version) {
  const cmd = startCommand(o, where, version)
  if (!o.priorDecisions) return servicePrompt(`Run exactly this one command, ${START_TIMEOUT}:\n\n${cmd}`, STEP)
  // One line of JSON (JSON.stringify escapes every newline), so no line of it can be the quoted heredoc's delimiter.
  return servicePrompt(
    `Run exactly this one command, ${START_TIMEOUT}, the line between the heredoc's markers copied character for character:\n\n${cmd} --prior-decisions - <<'${PRIOR_DECISIONS_EOF}'\n${o.priorDecisions}\n${PRIOR_DECISIONS_EOF}`,
    STEP,
  )
}

/**
 * The start as the service agent is asked to issue it, for naming a refused one: its first line, the heredoc that
 * hands the launcher's records on stdin opened, not copied (the refusal names its body outside the quote).
 * @param {Options} o @param {import('./cli-review-commands.mjs').Where} where @param {string} version @returns {string}
 */
function startIssued(o, where, version) {
  const cmd = startCommand(o, where, version)
  return o.priorDecisions ? `${cmd} --prior-decisions - <<'${PRIOR_DECISIONS_EOF}'` : cmd
}

/**
 * The step that runs a submit or a comment (integrations/shared/cli-review-commands.mjs), `cmd` its command: with `--resume`
 * (`run=`) an answer still missing is handed out again, not counted as a failed attempt; an `--abandoned` task the
 * binary fails at once. @param {string} cmd @returns {string}
 */
const submitPrompt = cmd => servicePrompt(`Run exactly this one command, ${SUBMIT_TIMEOUT}:\n\n${cmd}`, STEP)

/**
 * The submit's step, its command named to `serve`. @param {Serve} serve @param {string} label @param {string} title
 * @param {Parameters<typeof submitCommand>} parts @returns {Promise<unknown>}
 */
function submitStep(serve, label, title, ...parts) {
  const cmd = submitCommand(...parts)
  return paged(serve, label, title, parts[0], serve(label, title, submitPrompt(cmd), cmd))
}

/** A page's lines, as the service agent is told them. */
const PAGE_LINES =
  "exactly three lines: the craft-out line, the page's one body line copied whole, character for character, never split, wrapped or trimmed however long it is, and the craft-page line"
/** What a paged command prints: its step whole on one line, or its first page, framed (integrations/shared/cli-review-paged.mjs). */
const STEP = `either one line of JSON or, when the step is paged, ${PAGE_LINES} —`
/** What a page step prints (integrations/shared/cli-review-paged.mjs). */
const PAGE = `${PAGE_LINES} —`

/**
 * A paged command's step read whole: its answer `got`, then the rest of its step a page at a time, each page its own
 * step running `craft review page` (integrations/shared/cli-review-paged.mjs; realm @nick/craft, node #625).
 * @param {Serve} serve @param {string} label @param {string} title @param {string} bin @param {Promise<unknown>} got
 * @returns {Promise<unknown>}
 */
async function paged(serve, label, title, bin, got) {
  return readPaged(await got, (run, from) => {
    const cmd = pageCommand(bin, run, from)
    return serve(`${label}:page`, title, servicePrompt(`Run exactly this one command:\n\n${cmd}`, PAGE), cmd)
  })
}

/**
 * The step a resumed run (`run`) goes on from: the binary's submit over the run directory, which hands a stopped run's
 * held tasks out again and reads an interrupted one's answer files. Only the binary's own refusal — the command ran
 * and exited 1, the exit of every error it reports: no state.json of its current format, a finished run, or a
 * checkout whose HEAD or tracked files moved since the run started — is a run that cannot be resumed, said in the
 * binary's own words, and `refused` says so, so no resume of it is offered. A command cut off (a timeout's 124, a
 * signal's 128 and above) or a service agent that died (under the account's limit agent() usually comes back null with
 * no text, realm @nick/craft, #300) or ran into the limit is reported as itself.
 * @param {string} run @param {unknown} got @param {string} [done]  what the binary refused to do with the run
 * @returns {{ step: Step } | { error: string, harness?: string, refused?: true }}
 */
function resumed(run, got, done = 'resumed') {
  const read = readStep(got)
  // A command the harness refused never ran: the run can still be resumed (realm @nick/craft, node #485).
  if (!('error' in read) || 'harness' in read || !isObject(got) || got['exitCode'] !== BINARY_REFUSED) return read
  const why = String(got['stderr'] ?? '')
    .trim()
    .replace(/^craft: /, '')
    .slice(0, 400)
  return { error: `run=${JSON.stringify(run)} cannot be ${done}: ${why || read.error}`, refused: true }
}

/** The exit of a `craft` command that reported an error (main.rs: `ExitCode::FAILURE`). */
const BINARY_REFUSED = 1

/**
 * Why the run stopped, where it stood only as the binary reports it (`standing`, '' when it reports none: the driver's
 * own count of steps is no round of the review; realm @nick/craft, node #485), and, whenever a run directory is known,
 * where it is and how to resume it: the account's limit often leaves no text at all, so no error is told apart here but
 * the harness's refusal and the limit's note, which already says the run stopped.
 * @param {string} standing @param {{ error: string, harness?: string }} read @param {string} run  the run directory,
 *   '' when none is known @param {string} bin  the binary as the commands spell it
 * @returns {string}
 */
function stoppedAt(standing, read, run, bin) {
  const reports = standing ? ` (the binary reports ${standing})` : ''
  if (read.harness !== undefined) return `review stopped${reports}: ${harnessStop(read.harness, bin, run)}`
  // The limit's note says itself that the run stopped, in the words a parent reads a nested run's stop by
  // (limitInReport): it is told once, as the binary's own line tells it (realm @nick/craft, node #688).
  const said = read.error.startsWith(STOPPED) ? `${read.error}${reports}` : `review stopped${reports}: ${read.error}`
  return `${said}.${run ? ` The run is in ${run}. ${resumeHint(run)}` : ''}`
}

/** @typedef {import('./cli-review-ended.mjs').Brief} Brief */
/** @typedef {{ finished: Finished } | { stopped: string, cause: import('./cli-review-stop.mjs').StopCause } | { unknown: string } | { unrecorded: string } | { unread: Brief } | { refused: string }} Ending  refused: the binary's start refused an argument, before any work; unknown: recovery failed without establishing completion; unrecorded: the binary finished the run but left nothing to file its record from; unread: the binary ended it, but only its brief status could be read */
/** @typedef {{ finished: Finished } | { unrecorded: string } | { standing: string } | { unread: Brief } | { failed: { error: string, harness?: string } }} Recovery */
/** @typedef {ReturnType<typeof cliRecorder>} Recorder */
/** @typedef {import('./cli-step-loop.mjs').Rounds<Exclude<Step, Finished>, Finished, Ending>} Rounds  the review's part of the step rounds */

/**
 * The run of one review, then its answer — the verdict block, and the telemetry section when a write did not land. A
 * run the binary finished was filed by the binary itself (`filing` on its steps); only one the binary never finished
 * — its step unreadable, the round backstop, a resume refused — is filed here, INCOMPLETE, into the run directory the
 * binary's checkpoints went to. An argument refused before anything ran files only its refusal.
 * A nested run (`_via`) tells the binary and its records no output tokens: the pool is the turn's, shared with its
 * siblings and its parent, whose own record covers it.
 * @param {Sandbox} given @param {string} craftVersion @returns {Promise<string>}
 */
export async function runCliReview(given, craftVersion) {
  const a = normalizeArgs(given.args, given.log)
  const sb = viaName(a['_via']) ? { ...given, budget: runBudget(undefined) } : given
  const problem = argumentProblem(a, readOptions)
  if (problem) return refuse(sb, craftVersion, a, problem)
  const o = /** @type {{ options: Options }} */ (readOptions(a)).options
  const { limit, service } = serviceOf(sb)
  const one = oneStep(sb, o, craftVersion, serveWith(service, limit))
  if (one) return one
  // The task agents counted for the binary's runtimeStats, and the binary's clock read off its steps for the record of
  // a run it never finished.
  const clock = runClock()
  const recorder = cliRecorder(sb, { craftVersion, repo: o.repo, run: o.run, depth: o.depth || 'full', strict: o.strict, via: o.via, service })
  const ending = await drive({ ...sb, limit, clock }, o, craftVersion, service, recorder)
  if (!('stopped' in ending)) return endedAnswer(sb, ending, recorder, { craftVersion, via: o.via })
  sb.phase('Record')
  // A resumed run whose resume ended before the binary named its repository, with none given, has no checkout to key
  // a record to: filing it under the session's would put it in another repository's history.
  const unkeyed = !!o.run && !recorder.keyed()
  if (!unkeyed) await recorder.file({ verdict: 'INCOMPLETE', notRun: stopNotRun(ending.cause), runtimeStats: clock.stats() })
  return withNotes(stoppedAnswer(ending.stopped), [
    unkeyed ? "No run record was filed: the resumed run's repository is unknown (the resume ended before the binary named it, and no repo= was given)." : '',
    recorder.notes(),
  ])
}

/**
 * The answer of a run that did not stop short — finished, its last step lost, read only by its brief status, or an
 * argument its start refused — none of which is filed INCOMPLETE here.
 * @param {Sandbox} sb @param {Exclude<Ending, { stopped: string, cause: import('./cli-review-stop.mjs').StopCause }>} ending @param {Recorder} recorder
 * @param {{ craftVersion: string, via: string }} at @returns {Promise<string>}
 */
async function endedAnswer(sb, ending, recorder, at) {
  if ('finished' in ending) return withNotes(finishedAnswer(ending.finished), [recorder.settled(ending.finished)])
  if ('unknown' in ending) return withNotes(stoppedAnswer(ending.unknown), [UNKNOWN_COMPLETION, recorder.notes()])
  // Never an INCOMPLETE record of a run the binary finished: its record is said missing.
  if ('unrecorded' in ending) return withNotes(stoppedAnswer(`review lost the run's last step: ${ending.unrecorded}`), [recorder.missing(ending.unrecorded)])
  if ('unread' in ending) return withNotes(unreadAnswer(ending.unread), [unreadNotes(ending.unread, recorder)])
  return refusedAnswer(sb, recorder, at, { why: ending.refused, cls: VALUE_REFUSED_CLASS })
}

/**
 * The notes of a run read only by its brief status: the telemetry section, and — when the binary finished it but its
 * record did not land — that loss, and how to file it again.
 * @param {Brief} b @param {Recorder} recorder @returns {string}
 */
function unreadNotes(b, recorder) {
  if (!b.done || b.record === 'filed') return recorder.notes()
  const lost = recorder.missing(`the craft binary finished the run but its record did not land (${b.record || 'none attempted'})`)
  return `${lost}The run record can be filed again: ${resumeHint(b.run).replace(/^To resume it once agents can answer again: /, '')}`
}

/**
 * The gate alone (`gateOnly`): the binary got as for a review, then `craft review gate`, its answer the verdict block
 * and the gate's section. It opens no run, so nothing is filed: the parent that asked for it carries the gate in its own
 * record (rust-audit's `gate` dimension; realm @nick/craft, node #150).
 * @param {Sandbox} sb @param {Options} o @param {string} craftVersion @param {Serve} serve @returns {Promise<string>}
 */
async function gateAlone(sb, o, craftVersion, serve) {
  sb.log(`review ${craftVersion}: the mechanical gate alone over ${o.repo || 'the session checkout'}`)
  sb.phase('Start')
  // A given craftBin runs as it is: the gate files nothing, so no plugin root is located for a record.
  const where = o.craftBin !== null && !o.craftRoot ? { bin: o.craftBin } : await binAndRoot('review', o, craftVersion, serve)
  if ('incomplete' in where) return stoppedAnswer(where.incomplete)
  const read = gateAnswer(await serve('step:gate', 'Start', servicePrompt(gateCommand(where.bin, o)), gateShell(where.bin, o)))
  if ('answer' in read) return read.answer
  // The gate opens no run, so there is none to resume (realm @nick/craft, node #485).
  return stoppedAnswer(`review's gate did not run: ${read.harness === undefined ? read.error : harnessRefused(read.harness, where.bin)}`)
}

/**
 * The runs that are one binary command rather than a review's loop: the gate alone, and a finished run published on its
 * PR; null for a review.
 * @param {Sandbox} sb @param {Options} o @param {string} craftVersion @param {Serve} serve @returns {Promise<string> | null}
 */
function oneStep(sb, o, craftVersion, serve) {
  if (o.gateOnly) return gateAlone(sb, o, craftVersion, serve)
  return o.run && o.comment ? publishAfter(sb, o, craftVersion, serve) : null
}

/**
 * A finished run's findings published on its PR after the fact (`run=` with `comment=true`; realm @nick/craft, node
 * #270): the binary's `craft review comment` sorts and posts them as a run started with comment does when it finishes,
 * and amends the run's record itself, so the driver files nothing — not even when the binary refuses (a run not
 * finished, uncommitted work, a PR head that moved over a defect's line), which it says in its own words.
 * @param {Sandbox} sb @param {Options} o @param {string} craftVersion @param {Serve} serve @returns {Promise<string>}
 */
async function publishAfter(sb, o, craftVersion, serve) {
  sb.log(`review ${craftVersion}: publishing the findings of the finished run ${o.run} on its PR`)
  sb.phase('Start')
  const where = await binAndRoot('review', o, craftVersion, serve)
  if ('incomplete' in where) return stoppedAnswer(where.incomplete)
  if (where.note) sb.log(where.note)
  const comment = commentCommand(where, o)
  const got = await paged(serve, 'step:comment', 'Submit', where.bin, serve('step:comment', 'Submit', submitPrompt(comment), comment))
  const read = resumed(o.run, got, 'published on its PR')
  // The comment ran when only a page step of its step stopped — a refusal there included: what it posted is unknown.
  if ('error' in read) return unreadRun(got) === null ? unpublished(o.run, read, where.bin) : unknownPublication(o.run, read.error)
  if (!read.step.done) return unknownPublication(o.run, `the binary answered with no finished run: ${JSON.stringify(read.step).slice(0, 200)}`)
  const lost = read.step.filing?.lost ?? []
  for (const line of lost) sb.log(`⚠️ telemetry: ${line}`)
  return withNotes(finishedAnswer(read.step), [telemetryLostSection(lost)])
}

/**
 * The answer for a publication whose step brought no finished run back: refused by the harness, the command never ran,
 * so nothing was posted (realm @nick/craft, node #485); refused by the binary, said in its words; otherwise unknown.
 * @param {string} run @param {{ error: string, harness?: string, refused?: true }} read @param {string} bin  the binary
 *   as the commands spell it @returns {string}
 */
function unpublished(run, read, bin) {
  if (read.harness !== undefined) return `## Verdict\n\n⚠️ Nothing was posted on the PR — ${harnessRefused(read.harness, bin)}`
  return read.refused ? `## Verdict\n\n⚠️ Nothing was posted on the PR — ${read.error}${notFinishedHint(run, read.error)}` : unknownPublication(run, read.error)
}

/**
 * For a run the binary says has not finished — stopped or interrupted —, the two moves in the Workflow's words; '' else.
 * @param {string} run @param {string} error @returns {string}
 */
const notFinishedHint = (run, error) =>
  /has not finished/.test(error)
    ? ` — resume it with the Workflow \`craft:review run=${run}\` alone, then publish its findings with \`run=${run} comment=true\`.`
    : ''

/**
 * A publication whose step was lost — cut off, its agent dead, its output unreadable, or a page of its step stopped,
 * the harness's refusal of a page step included — after the binary may have posted: the outcome is said unknown, with
 * why and where to read it.
 * @param {string} run @param {string} error @returns {string}
 */
const unknownPublication = (run, error) =>
  `## Verdict\n\n⚠️ review lost the publication's step (${error}): whether anything was posted on the PR is unknown. Check the PR for comments carrying the craft-finding marker, and the run's state with \`craft review status --run '${run.replace(/'/g, "'\\''")}'\` (its \`filing\` and its report's PR comments section); running run= with comment=true again posts nothing twice.`

/** `answer`, then each note that says something. @param {string} answer @param {string[]} notes @returns {string} */
function withNotes(answer, notes) {
  const said = notes.filter(Boolean).join('\n\n')
  return said ? `${answer}\n\n${said}` : answer
}

/**
 * A refused argument: the logger the only agent, its record the engines' refusal (integrations/shared/run-record.mjs, argumentRefusal)
 * with the refusal's class in `notRun`, keyed to the repo given — the session's checkout when `repo` is itself the
 * refused argument, as the engines file theirs — then the answer saying what was refused.
 * @param {Sandbox} sb @param {string} craftVersion @param {Record<string, unknown>} a @param {{ why: string, cls: string }} problem
 * @returns {Promise<string>}
 */
async function refuse(sb, craftVersion, a, { why, cls }) {
  const via = viaName(a['_via']) ?? ''
  const service = makeDefaultTypeFallback(
    (/** @type {string} */ p, /** @type {Record<string, unknown>} */ opts) => sb.agent(p, opts),
    sb.log,
    () => false,
  )
  const recorder = cliRecorder(sb, { craftVersion, repo: absolutePath(a['repo']) ?? '', depth: 'full', strict: false, via, service })
  return refusedAnswer(sb, recorder, { craftVersion, via }, { why, cls })
}

/**
 * The refusal of an argument filed through `recorder` — the engines' refusal record, its class in `notRun` — then the
 * answer saying what was refused.
 * @param {Sandbox} sb @param {Recorder} recorder @param {{ craftVersion: string, via: string }} at
 * @param {{ why: string, cls: string }} problem @returns {Promise<string>}
 */
async function refusedAnswer(sb, recorder, { craftVersion, via }, { why, cls }) {
  const refused = argumentRefusal({ engine: 'review', why, notRun: [cls], craftVersion, outputTokens: sb.budget?.spent() ?? null, via })
  sb.phase('Record')
  await recorder.refusal(refused.record)
  const notes = recorder.notes()
  return notes ? `${stoppedAnswer(why)}\n\n${notes}` : stoppedAnswer(why)
}

/** @typedef {Sandbox & { limit: ReturnType<typeof import('./cli-review-limit.mjs').limitWatch>, clock: ReturnType<typeof runClock> }} Watched */

/**
 * The whole loop: start, then rounds of agents and submits until the binary is done. Fails closed: a step that cannot
 * be read ends the run, saying where; a budget throw propagates. A service step that came back with nothing once the
 * usage limit was seen stopped on it.
 * @param {Watched} sb @param {Options} o @param {string} craftVersion
 * @param {import('./cli-review-record.mjs').Service} service @param {Recorder} recorder
 * @returns {Promise<Ending>}
 */
async function drive(sb, o, craftVersion, service, recorder) {
  const serve = serveWith(service, sb.limit)
  sb.log(`review ${craftVersion}: ${o.craftBin ?? `the released binary ${craftVersion}`} over ${o.repo || 'the session checkout'}`)
  sb.phase('Start')
  const where = await binAndRoot('review', o, craftVersion, serve)
  if ('incomplete' in where) return { stopped: where.incomplete, cause: where.cause }
  const filedThrough = filedRoot(sb, where, recorder)
  const started = await opening(sb, o, craftVersion, serve, { ...where, filedThrough })
  if ('argument' in started) return { refused: started.argument }
  if ('error' in started) return openingLost(sb, o, where.bin, serve, recorder, started)
  // The record is keyed to the repository the run reviews, which the binary names: a resumed run's, and a start's that
  // reviews elsewhere than the checkout given — craft's own worktree of the PR given (realm @nick/craft, node #517).
  const reviews = started.step.repo
  if (reviews && (o.run || reviews !== o.repo)) recorder.keyTo(reviews)
  sb.clock.observe(started.step)
  recorder.heard(started.step)
  return rounds(sb, where.bin, started.step, serve, recorder)
}

/**
 * How a run ends whose first step was not read. A resume the binary did not refuse and the harness ran may have gone
 * on, even to the end: the binary is asked before anything is filed, as after a lost submit (realm @nick/craft, node
 * #736): one whose first page named its run ran, even when the harness refused a later page step. A start's lost step,
 * a refused resume and one the harness never ran stop where they are.
 * @param {Watched} sb @param {Options} o @param {string} bin @param {Serve} serve @param {Recorder} recorder
 * @param {{ error: string, harness?: string, refused?: true, run?: string }} started @returns {Promise<Ending>}
 */
async function openingLost(sb, o, bin, serve, recorder, started) {
  const ran = started.harness === undefined || started.run !== undefined
  if (o.run && !started.refused && ran) return afterLost(sb, bin, o.run, serve, recorder, started)
  return { stopped: stoppedAt('', started, runOfStop(started, o), bin), cause: stopCause(started, 'start') }
}

/**
 * The run directory a stopped opening names: none for a run the binary refused to resume; a start's that made its run
 * though its step was not read; else the one given.
 * @param {{ refused?: true, run?: string }} started @param {Options} o @returns {string}
 */
const runOfStop = (started, o) => (started.refused ? '' : (started.run ?? o.run))

/**
 * The run's first step: a resume's (`resumed`), or a start's — or why its binary refused an argument before any work
 * (`argument`).
 * @param {Watched} sb @param {Options} o @param {string} craftVersion @param {Serve} serve
 * @param {{ bin: string, root: string, filedThrough: string }} where
 * @returns {Promise<{ step: Step } | { error: string, harness?: string, refused?: true, run?: string } | { argument: string }>}
 */
async function opening(sb, o, craftVersion, serve, where) {
  if (o.run) {
    const resumeGot = await submitStep(serve, 'step:resume', 'Start', where.bin, o.run, { resume: true, recordRoot: where.filedThrough }, spentSoFar(sb))
    const resumeRead = resumed(o.run, resumeGot)
    // A resume whose first page named its run ran, though the harness refused a later page step.
    const named = unreadRun(resumeGot)
    return 'error' in resumeRead && named !== null ? { ...resumeRead, run: named } : resumeRead
  }
  const got = await paged(
    serve,
    'step:start',
    'Start',
    where.bin,
    serve('step:start', 'Start', startPrompt(o, where, craftVersion), startIssued(o, where, craftVersion)),
  )
  const argument = argumentRefused(got)
  if (argument) return { argument }
  const read = readStep(got)
  // A start whose step was paged but not read whole still made its run.
  const run = unreadRun(got)
  return 'error' in read && run !== null ? { ...read, run } : read
}

/**
 * The plugin root the run is filed through, handed to the recorder, and why none was located when it was not.
 * @param {Watched} sb @param {{ root: string, recordRoot?: string, note?: string }} where @param {Recorder} recorder
 * @returns {string}
 */
function filedRoot(sb, where, recorder) {
  if (where.note) sb.log(where.note)
  const root = where.recordRoot || where.root
  recorder.at(root)
  return root
}

/**
 * What the binary's telemetry is told on a submit: the task agents dispatched so far and the output tokens spent.
 * @param {Watched} sb @returns {{ agents: number, tokens: number | null }}
 */
const spentSoFar = sb => ({ agents: sb.clock.stats().agents, tokens: sb.budget?.spent() ?? null })

/**
 * Rounds of agents and submits from `first` until the binary is done. Once a task agent ran into the usage limit no
 * other is dispatched, and the submit hands the binary its text, which ends the run. Each step's telemetry write —
 * the binary's checkpoint as one of its phases ends — is heard for the answer's notes.
 * @param {Watched} sb @param {string} bin @param {Step} first @param {Serve} serve @param {Recorder} recorder
 * @returns {Promise<Ending>}
 */
async function rounds(sb, bin, first, serve, recorder) {
  // Only the task agents are counted for the record's runtimeStats.agents: the work the review dispatched, as the
  // engine's agents are its review agents; the service steps that run the binary are not.
  // Counted inside the limit's watch, so a call it answers without dispatching once the limit is seen is not.
  const tasks = taskRunner({ ...sb, agent: sb.limit.tasks(sb.clock.counted(sb.agent)) }, () => !!sb.limit.seen())
  /** @type {Rounds} */
  const review = {
    maxRounds: MAX_ROUNDS,
    dispatch: (step, round) => dispatchTasks(sb, tasks, step, round),
    submit: async (step, round) => {
      sb.phase('Submit')
      if (sb.limit.seen())
        sb.log(`\u26d4 usage limit reached (${sb.limit.seen()}) — no further review agents are dispatched; the run reports what it has as INCOMPLETE`)
      const said = { degraded: tasks.degraded(round), abandoned: tasks.abandoned(), limit: sb.limit.seen() }
      return readStep(await submitStep(serve, `step:submit:${round}`, 'Submit', bin, step.run, said, spentSoFar(sb)))
    },
    heard: step => {
      sb.clock.observe(step)
      recorder.heard(step)
    },
    lost: read => afterLost(sb, bin, first.run, serve, recorder, read),
    gaveUp: step => ({ stopped: `review gave up after ${MAX_ROUNDS} rounds; the run is in ${step.run}. ${resumeHint(step.run)}`, cause: 'rounds' }),
    finished: step => ({ finished: step }),
  }
  return stepRounds(first, review)
}

/**
 * How a run ends whose submit or resume output was lost (`read`): as the binary's status says it ended, else stopped
 * where it stands — a lost step of the binary, unless the harness or the limit stopped it; a status that failed leaves
 * its completion unknown (realm @nick/craft, nodes #731, #736).
 * @param {Watched} sb @param {string} bin @param {string} run @param {Serve} serve @param {Recorder} recorder
 * @param {{ error: string, harness?: string }} read @returns {Promise<Ending>}
 */
async function afterLost(sb, bin, run, serve, recorder, read) {
  const truth = await recovered(sb, bin, run, serve, recorder)
  const why = stopRead(read, sb.limit.seen())
  if ('failed' in truth) {
    const failure = truth.failed.harness === undefined ? truth.failed.error : harnessRefused(truth.failed.harness, bin)
    return { unknown: `${stoppedAt('', why, run, bin)}\n\nStatus recovery failed: ${failure}` }
  }
  if (!('standing' in truth)) return truth
  return { stopped: stoppedAt(truth.standing, why, run, bin), cause: stopCause(why, 'step') }
}

/**
 * A submit whose output could not be read — garbled, cut by the Bash timeout, its agent dead after the command ran —
 * may still have finished the run and filed its record: the binary is asked what it did before the driver files
 * anything. A run it finished with its record filed, or a stopped one, ends as the binary left it; a finished run
 * whose record did not land has it filed again (`--resume`), and ends as it stands if that cannot be read; a run it
 * did not finish comes back as where it stands, as its status says (`standing`), which the driver then files
 * INCOMPLETE; a run it finished without keeping the step to file its record from is said so, and filed by no one.
 * A status that ran but could not be read — empty, missing, too large to copy whole, its page step failed or refused
 * by the harness — is asked again in brief (briefly).
 * @param {Watched} sb @param {string} bin @param {string} run @param {Serve} serve @param {Recorder} recorder
 * @returns {Promise<Recovery>}
 */
async function recovered(sb, bin, run, serve, recorder) {
  const said = await paged(serve, 'step:status', 'Submit', bin, serve('step:status', 'Submit', statusPrompt(bin, run), statusCommand(bin, run)))
  if (statusUnreadable(said)) return briefly(sb, bin, run, serve, recorder)
  const failed = recoveryFailure(said, statusCommand(bin, run))
  if (failed) return { failed }
  const truth = endedOf(said)
  if (!truth) return { standing: standingOf(said) }
  if ('unrecorded' in truth) return truth
  const again = truth.refile ? readStep(await submitStep(serve, 'step:refile', 'Submit', bin, run, { resume: true }, spentSoFar(sb))) : null
  // A re-file that could not be read leaves the run as the binary left it, its record said missing — never a
  // second, INCOMPLETE record of a run the binary finished.
  const ended = again && 'step' in again && again.step.done ? again.step : truth.finished
  sb.log(`the run's last step could not be read; the binary says it ended: ${ended.verdict}`)
  recorder.heard(ended)
  return { finished: ended }
}

/**
 * The run as the binary's brief status says it ended, for a status that could not be read: never an INCOMPLETE
 * record of a run the binary ended (realm @nick/craft, node #522). A finished run whose record did not land has it
 * filed again (`--resume`): a re-file read whole ends the run as a lost submit's does (recovered); one not read — it
 * is the same large step — has the brief status asked once more. What the telemetry's writes lost and the stopped
 * parts still waiting go to the answer's telemetry section.
 * @param {Watched} sb @param {string} bin @param {string} run @param {Serve} serve @param {Recorder} recorder
 * @returns {Promise<Recovery>}
 */
async function briefly(sb, bin, run, serve, recorder) {
  const brief = briefStatusCommand(bin, run)
  const ask = () => serve('step:brief', 'Submit', servicePrompt(`Run exactly this one command:\n\n${brief}`), brief)
  const said = await ask()
  const failed = recoveryFailure(said, brief)
  if (failed) return { failed }
  const first = briefOf(said)
  if (!first) return { standing: standingOf(said) }
  if (!('unread' in first)) return first
  let ended = first.unread
  if (first.refile) {
    const again = readStep(await submitStep(serve, 'step:refile', 'Submit', bin, run, { resume: true }, spentSoFar(sb)))
    if ('step' in again && again.step.done) {
      recorder.heard(again.step)
      return { finished: again.step }
    }
    const asked = briefOf(await ask())
    if (asked && 'unread' in asked) ended = asked.unread
  }
  sb.log(`the run's last step and status could not be read whole; the binary's brief status says it ended: ${ended.verdict}`)
  recorder.told([
    ...ended.lost,
    ...(ended.pending ? [`the records of ${ended.pending} stopped part(s) of the run — not landed yet; a resume sends them again`] : []),
  ])
  return { unread: ended }
}

/** The step that asks the binary where the run stands. @param {string} bin @param {string} run @returns {string} */
const statusPrompt = (bin, run) => servicePrompt(`Run exactly this one command:\n\n${statusCommand(bin, run)}`, STEP)
