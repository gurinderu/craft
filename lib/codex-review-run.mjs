// The Codex driver's loop over the CLI's step protocol (realm @nick/craft, nodes #453, #491): the same protocol the
// Claude Code driver runs (lib/cli-review-steps.mjs) — start or resume, then rounds of tasks and submits until the
// binary is done — with the same command lines (lib/cli-review-commands.mjs), step reader (lib/cli-review-step.mjs),
// recovery through `craft review status` (lib/cli-review-ended.mjs) and answer (lib/cli-review-verdict.mjs). Here
// the driver is a Node process, so it runs the binary itself and each task as its own `codex exec`. It holds no
// review logic: what to ask, of which model, in which shape and what the answers mean are all the binary's. A run the
// binary never finished is filed INCOMPLETE by the driver (lib/codex-review-record.mjs); every telemetry write that
// did not land is said in the answer. Another host drives the same loop by handing in its own round runner
// (`runRound` in the context: the OpenCode plugin's child sessions, lib/opencode-review-round.mjs); without one a
// round is Codex's (lib/codex-review-round.mjs).
import { MAX_ROUNDS, commentCommand, startCommand, statusCommand, submitCommand } from './cli-review-commands.mjs'
import { readStep } from './cli-review-step.mjs'
import { endedOf, standingOf } from './cli-review-ended.mjs'
import { finishedAnswer, resumeHint, stoppedAnswer } from './cli-review-verdict.mjs'
import { gateAnswer, gateShell } from './cli-review-gate.mjs'
import { runShell } from './codex-review-spawn.mjs'
import { runRound } from './codex-review-round.mjs'
import { runClock } from './cli-review-clock.mjs'
import { telemetryLostSection } from './review-coverage.mjs'

/** @typedef {import('./cli-review-options.mjs').Options} Options */
/** @typedef {import('./cli-review-step.mjs').Step} Step */
/** @typedef {import('./cli-review-step.mjs').Finished} Finished */
/** @typedef {import('./codex-review-round.mjs').RoundResult} RoundResult */
/** @typedef {(tasks: import('./cli-review-step.mjs').Task[], round: number, watch: { limit: string }) => Promise<RoundResult>} RoundRunner  a host's own way to run one step's tasks */
/** @typedef {{ bin: string, version: string, pluginRoot: string, driver: (run: string) => string, log: (line: string) => void, recorder: import('./codex-review-record.mjs').Recorder, repo: string, env: NodeJS.ProcessEnv }} Base */
/** @typedef {Base & ({ runRound: RoundRunner } | ({ concurrency: number } & import('./codex-review-task.mjs').TaskContext))} Ctx */
/** @typedef {{ answer: string, finished: boolean }} Answer */
/** @typedef {{ finished: Finished } | { stopped: string } | { unrecorded: string }} Ending */
/** @typedef {Ctx & { clock: ReturnType<typeof runClock>, spent: import('./cli-review-commands.mjs').Spent }} Running */

// The start may fetch integration sources (240 s) and run the mechanical gate (300 s); a submit may file telemetry
// and post on the PR: generous bounds, so a hung binary cannot hold the session for ever.
const COMMAND_TIMEOUT_MS = 15 * 60 * 1000

/** The binary's command, run with the driver's environment. @param {Ctx} ctx @param {string} line @param {string} [stdin] */
const binary = (ctx, line, stdin = '') => runShell(line, { cwd: ctx.repo, env: ctx.env, stdin, timeoutMs: COMMAND_TIMEOUT_MS })

/** Where the binary runs from: its prompts name the given craftRoot or none, the run is filed through this plugin. @param {Options} o @param {Ctx} ctx */
const whereOf = (o, ctx) => ({ bin: ctx.bin, root: o.craftRoot, recordRoot: ctx.pluginRoot })

/** `answer`, then each note that says something. @param {string} answer @param {string[]} notes */
const withNotes = (answer, notes) => [answer, ...notes.filter(Boolean)].join('\n\n')

/**
 * The review: the gate alone, a finished run published on its PR, or the step loop. Neither of the first two opens a
 * run, so neither files a record; the binary amends a published run's record itself.
 * @param {Options} o @param {Ctx} ctx @returns {Promise<Answer>}
 */
export async function driveReview(o, ctx) {
  if (o.gateOnly) {
    const read = gateAnswer(await binary(ctx, gateShell(ctx.bin, o)))
    return 'answer' in read ? { answer: read.answer, finished: true } : { answer: stoppedAnswer(`review's gate did not run: ${read.error}`), finished: false }
  }
  if (o.run && o.comment) return publishAfter(o, ctx)
  const running = { ...ctx, clock: runClock(), spent: { agents: 0, tokens: null } }
  return ended(await loop(o, running), o, running)
}

/** @param {Options} o @param {Ctx} ctx @returns {Promise<Answer>} */
async function publishAfter(o, ctx) {
  const read = readStep(await binary(ctx, commentCommand(whereOf(o, ctx), o)))
  if ('error' in read) return { answer: stoppedAnswer(`the publication of ${o.run} did not finish: ${read.error}`), finished: false }
  if (!read.step.done) return { answer: stoppedAnswer('the binary answered with no finished run'), finished: false }
  ctx.recorder.heard(read.step)
  return { answer: withNotes(finishedAnswer(read.step, ctx.driver(read.step.run)), [telemetryLostSection(read.step.filing?.lost ?? [])]), finished: true }
}

/**
 * The answer of a run that ended: a finished one with its telemetry notes; one the binary never finished filed
 * INCOMPLETE first — unless it is a resumed run whose repository nobody named, whose record would land in another
 * repository's history.
 * @param {Ending} ending @param {Options} o @param {Running} r @returns {Promise<Answer>}
 */
async function ended(ending, o, r) {
  if ('finished' in ending) return { answer: withNotes(finishedAnswer(ending.finished, r.driver(ending.finished.run)), [r.recorder.settled(ending.finished)]), finished: true }
  if ('unrecorded' in ending) return { answer: withNotes(stoppedAnswer(`review lost the run's last step: ${ending.unrecorded}`), [r.recorder.missing(ending.unrecorded)]), finished: false }
  r.clock.tally(r.spent.agents)
  const unfiled = await r.recorder.unfinished(!!o.run, { verdict: 'INCOMPLETE', notRun: ['the craft binary did not finish the run'], runtimeStats: r.clock.stats() })
  return { answer: withNotes(stoppedAnswer(ending.stopped), [unfiled, r.recorder.notes()]), finished: false }
}

/** A step the binary printed, heard by the recorder and the clock. @param {Running} r @param {Step} step */
function heard(r, step) {
  r.clock.observe(step)
  r.recorder.heard(step)
}

/** @param {Options} o @param {Running} r @returns {Promise<Ending>} */
async function loop(o, r) {
  const first = o.run
    ? readStep(await binary(r, submitCommand(r.bin, o.run, { resume: true, recordRoot: r.pluginRoot }, r.spent)))
    : readStep(await binary(r, `${startCommand(o, whereOf(o, r), r.version)}${o.priorDecisions ? ' --prior-decisions -' : ''}`, o.priorDecisions))
  if ('error' in first) return { stopped: `review could not ${o.run ? 'resume' : 'start'}: ${first.error}` }
  if (o.run && first.step.repo) r.recorder.keyTo(first.step.repo)
  r.log(`run=${first.step.run}`)
  heard(r, first.step)
  return rounds(first.step, r)
}

/**
 * Rounds of tasks and submits from `step` until the binary is done.
 * @param {Step} step @param {Running} r @returns {Promise<Ending>}
 */
async function rounds(step, r) {
  const watch = { limit: '' }
  const run = step.run
  /** @type {Step} */
  let at = step
  for (let round = 1; !at.done; round++) {
    if (round > MAX_ROUNDS) return { stopped: `review gave up after ${MAX_ROUNDS} rounds; the run is in ${run}. ${resumeHint(run, r.driver(run))}` }
    r.log(`round ${round}${at.phase ? ` (${at.phase})` : ''}: ${at.tasks.length} task(s) — ${at.tasks.map(t => t.label).join(', ')}`)
    const said = await ('runRound' in r ? r.runRound(at.tasks, round, watch) : runRound(at.tasks, round, r, watch))
    r.spent.agents += said.dispatched
    const read = readStep(await binary(r, submitCommand(r.bin, run, said, r.spent)))
    if ('error' in read) return recovered(run, read.error, r)
    heard(r, read.step)
    at = read.step
  }
  return { finished: at }
}

/**
 * A submit whose output could not be read may still have finished the run: the binary is asked what it did. A finished
 * run whose record did not land has it filed again (`--resume`); a run it did not finish is reported where it stands.
 * @param {string} run @param {string} error @param {Running} r @returns {Promise<Ending>}
 */
async function recovered(run, error, r) {
  const said = await binary(r, statusCommand(r.bin, run))
  const truth = endedOf(said)
  if (!truth) {
    const standing = standingOf(said)
    return { stopped: `review stopped${standing ? ` (the binary reports ${standing})` : ''}: ${error}. The run is in ${run}. ${resumeHint(run, r.driver(run))}` }
  }
  if ('unrecorded' in truth) return truth
  const again = truth.refile ? readStep(await binary(r, submitCommand(r.bin, run, { resume: true, recordRoot: r.pluginRoot }, r.spent))) : null
  const last = again && 'step' in again && again.step.done ? again.step : truth.finished
  r.log(`the run's last step could not be read; the binary says it ended: ${last.verdict}`)
  r.recorder.heard(last)
  return { finished: last }
}
