// The loop of a process-per-task review driver over the CLI's step protocol (realm @nick/craft, node #453): the same
// protocol the Claude Code driver runs (lib/cli-review-steps.mjs) — start or resume, then rounds of tasks and submits
// until the binary is done — with the same command lines (lib/cli-review-commands.mjs), step reader
// (lib/cli-review-step.mjs), recovery through `craft review status` (lib/cli-review-ended.mjs) and answer
// (lib/cli-review-verdict.mjs). Here the driver is a Node process: it runs the binary itself, and each task through
// the host's adapter (`runTask`: the pi one is lib/pi-review-task.mjs). It holds no review logic: what to ask, of
// which model, in which shape and what the answers mean are all the binary's.
import { MAX_ROUNDS, commentCommand, startCommand, statusCommand, submitCommand } from './cli-review-commands.mjs'
import { readStep } from './cli-review-step.mjs'
import { endedOf, standingOf } from './cli-review-ended.mjs'
import { finishedAnswer, resumeHint, stoppedAnswer } from './cli-review-verdict.mjs'
import { gateAnswer, gateShell } from './cli-review-gate.mjs'
import { runShell } from './task-process-spawn.mjs'
import { runRound } from './task-process-round.mjs'

/** @typedef {import('./cli-review-options.mjs').Options} Options */
/** @typedef {import('./cli-review-step.mjs').Step} Step */
/** @typedef {{ bin: string, version: string, pluginRoot: string, repo: string, env: NodeJS.ProcessEnv, driver: (run: string) => string } & import('./task-process-round.mjs').RoundContext} Ctx  bin: the binary as a shell word; driver: how to run this driver again on a run */
/** @typedef {{ answer: string, finished: boolean }} Answer */
/** @typedef {import('./cli-review-commands.mjs').Spent} Spent */

// The start may fetch integration sources (240 s) and run the mechanical gate (300 s); a submit may file telemetry
// and post on the PR: generous bounds, so a hung binary cannot hold the session for ever.
const COMMAND_TIMEOUT_MS = 15 * 60 * 1000

/** The binary's command, run with the driver's environment. @param {Ctx} ctx @param {string} line @param {string} [stdin] */
const binary = (ctx, line, stdin = '') => runShell(line, { cwd: ctx.repo, env: ctx.env, stdin, timeoutMs: COMMAND_TIMEOUT_MS })

/** Where the binary runs from: its prompts name the given craftRoot or none, the run is filed through this plugin. @param {Options} o @param {Ctx} ctx */
const whereOf = (o, ctx) => ({ bin: ctx.bin, root: o.craftRoot, recordRoot: ctx.pluginRoot })

/** @param {string} why @returns {Answer} */
const stopped = why => ({ answer: stoppedAnswer(why), finished: false })

/**
 * The review: the gate alone, a finished run published on its PR, or the step loop.
 * @param {Options} o @param {Ctx} ctx @returns {Promise<Answer>}
 */
export async function driveReview(o, ctx) {
  if (o.gateOnly) {
    const read = gateAnswer(await binary(ctx, gateShell(ctx.bin, o)))
    return 'answer' in read ? { answer: read.answer, finished: true } : stopped(`review's gate did not run: ${read.error}`)
  }
  if (o.run && o.comment) {
    const read = readStep(await binary(ctx, commentCommand(whereOf(o, ctx), o)))
    if ('error' in read) return stopped(`the publication of ${o.run} did not finish: ${read.error}`)
    return read.step.done ? { answer: finishedAnswer(read.step, ctx.driver(read.step.run)), finished: true } : stopped('the binary answered with no finished run')
  }
  return loop(o, ctx)
}

/** @param {Options} o @param {Ctx} ctx @returns {Promise<Answer>} */
async function loop(o, ctx) {
  /** @type {Spent} */
  const spent = { agents: 0, tokens: null }
  const first = o.run
    ? readStep(await binary(ctx, submitCommand(ctx.bin, o.run, { resume: true, recordRoot: ctx.pluginRoot }, spent)))
    : readStep(await binary(ctx, `${startCommand(o, whereOf(o, ctx), ctx.version)}${o.priorDecisions ? ' --prior-decisions -' : ''}`, o.priorDecisions))
  if ('error' in first) return stopped(`review could not ${o.run ? 'resume' : 'start'}: ${first.error}`)
  ctx.log(`run=${first.step.run}`)
  return rounds(first.step, ctx, spent)
}

/**
 * Rounds of tasks and submits from `step` until the binary is done.
 * @param {Step} step @param {Ctx} ctx @param {Spent} spent @returns {Promise<Answer>}
 */
async function rounds(step, ctx, spent) {
  const watch = { limit: '', login: '' }
  const run = step.run
  /** @type {Step} */
  let at = step
  for (let round = 1; !at.done; round++) {
    if (round > MAX_ROUNDS) return stopped(`review gave up after ${MAX_ROUNDS} rounds; the run is in ${run}. ${resumeHint(run, ctx.driver(run))}`)
    ctx.log(`round ${round}${at.phase ? ` (${at.phase})` : ''}: ${at.tasks.length} task(s) — ${at.tasks.map(t => t.label).join(', ')}`)
    const said = await runRound(at.tasks, round, ctx, watch)
    spent.agents += said.dispatched
    // Not logged in: no task can answer, so nothing is submitted; a resume hands the step's missing answers out again.
    if (said.login) return stopped(`${said.login}. The run is in ${run}. ${resumeHint(run, ctx.driver(run))}`)
    const read = readStep(await binary(ctx, submitCommand(ctx.bin, run, said, spent)))
    if ('error' in read) return recovered(run, read.error, ctx, spent)
    at = read.step
  }
  return { answer: finishedAnswer(at, ctx.driver(run)), finished: true }
}

/**
 * A submit whose output could not be read may still have finished the run: the binary is asked what it did. A finished
 * run whose record did not land has it filed again (`--resume`); a run it did not finish is reported where it stands.
 * @param {string} run @param {string} error @param {Ctx} ctx @param {Spent} spent @returns {Promise<Answer>}
 */
async function recovered(run, error, ctx, spent) {
  const said = await binary(ctx, statusCommand(ctx.bin, run))
  const truth = endedOf(said)
  if (!truth) {
    const standing = standingOf(said)
    return stopped(`review stopped${standing ? ` (the binary reports ${standing})` : ''}: ${error}. The run is in ${run}. ${resumeHint(run, ctx.driver(run))}`)
  }
  if ('unrecorded' in truth) return stopped(`review lost the run's last step: ${truth.unrecorded}`)
  const again = truth.refile ? readStep(await binary(ctx, submitCommand(ctx.bin, run, { resume: true, recordRoot: ctx.pluginRoot }, spent))) : null
  const ended = again && 'step' in again && again.step.done ? again.step : truth.finished
  ctx.log(`the run's last step could not be read; the binary says it ended: ${ended.verdict}`)
  return { answer: finishedAnswer(ended, ctx.driver(run)), finished: true }
}
