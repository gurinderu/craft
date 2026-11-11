// The `craft review` command lines of the CLI's step protocol (realm @nick/craft, node #453), as shell text: the
// Claude Code driver hands them to a service agent inside its prompts (lib/cli-review-steps.mjs), the Codex and pi
// drivers run them themselves (lib/task-process-run.mjs; realm @nick/craft, node #491). Each flag only when it differs from the
// binary's default.
import { shq } from './plugin-script.mjs'
import { launchFlags } from './cli-review-keys.mjs'

/** @typedef {import('./cli-review-options.mjs').Options} Options */
/** @typedef {{ bin: string, root: string, recordRoot?: string }} Where  the binary as a shell word; the plugin root its prompts name ('' to let it look above itself); the root the run is filed through when only that was located */
/** @typedef {{ degraded?: string[], limit?: string, resume?: boolean, recordRoot?: string, abandoned?: string[] }} Said  what a submit tells the binary of the step's tasks */
/** @typedef {{ agents: number, tokens: number | null }} Spent  the task agents dispatched so far and the output tokens spent (null: not counted) */

// The scout, a re-review's red team, up to three lens rounds, unit mode's coordinator (the Seam phase), the dedup,
// verification in up to two waves (a split deciding pair buys the rest of its panel), the completeness critic, the
// lenses it admits with their dedup and verification in up to two waves, the memory's match judge and its rule judge —
// sixteen steps, each asked at most three times (the binary's two retries): forty-eight rounds; three spare. Only a
// backstop: the binary decides when the run is done.
export const MAX_ROUNDS = 51

/**
 * The start's flags for its chain of review rounds: a new chain, the full re-scan's period, and the pull request under
 * review, whose head branch keys a detached HEAD's chain.
 * @param {Options} o @returns {string}
 */
const chainFlags = o => `${o.fresh ? ' --fresh' : ''}${o.fullEvery ? ` --full-every ${o.fullEvery}` : ''}${o.pr ? ` --pr ${o.pr}` : ''}`

/**
 * The start's flags for the round chain, strict mode, the gate, the extra lenses, unit mode, the scope, publishing on the
 * PR and the launch options.
 * @param {Options} o @returns {string}
 */
const reviewFlags = o => `${chainFlags(o)}${o.strict ? ' --strict' : ''}${o.gate ? '' : ' --no-gate'}${o.gateFrom ? ` --gate-from ${shq(o.gateFrom)}` : ''}${o.extraLenses ? ` --extra-lenses ${shq(o.extraLenses)}` : ''}${o.unitScope ? ' --unit-scope' : ''}${o.path ? ` --path ${shq(o.path)}` : ''}${o.comment ? ' --comment' : ''}${launchFlags(o)}`

/**
 * `craft review start`, without the launcher's records (`--prior-decisions -`, which the caller hands on stdin). The
 * binary stores the root in the run's state, so submit renders its retries and verifiers with the same one, and finds
 * the run-record adapter in it. `--record` has the binary file the run's telemetry itself under the driver's version,
 * `--via` naming the parent engine a nested run's record is filed under, `--record-root` the plugin root it is filed
 * through when that is not the one the prompts name.
 * @param {Options} o @param {Where} where @param {string} version  the driver's craft version @returns {string}
 */
export function startCommand(o, { bin, root, recordRoot }, version) {
  const record = `${recordRoot ? ` --record-root ${shq(recordRoot)}` : ''} --record ${shq(version)}${o.via ? ` --via ${shq(o.via)}` : ''}`
  return `${bin} review start --cwd ${o.repo ? shq(o.repo) : '.'}${o.base ? ` --base ${shq(o.base)}` : ''}${o.depth ? ` --depth ${o.depth}` : ''}${reviewFlags(o)}${root ? ` --craft-root ${shq(root)}` : ''}${record}`
}

/**
 * `craft review submit`, with a `--degraded` note for each way the step's tasks ran weaker than asked, an
 * `--abandoned` for each task abandoned at its deadline, the usage limit's text when a task ran into it (`--limit`),
 * `--resume` when it resumes a run, the plugin root known now (`--record-root`), then what the binary's telemetry
 * needs and only the driver sees: the task agents dispatched (`--agents`) and the output tokens spent.
 * @param {string} bin @param {string} run @param {Said} said @param {Spent} spent @returns {string}
 */
export const submitCommand = (bin, run, { degraded = [], limit = '', resume = false, recordRoot = '', abandoned = [] }, { agents, tokens }) => `${bin} review submit --run ${shq(run)}${degraded.map(n => ` --degraded ${shq(n)}`).join('')}${abandoned.map(id => ` --abandoned ${shq(id)}`).join('')}${limit ? ` --limit ${shq(limit)}` : ''}${resume ? ' --resume' : ''}${recordRoot ? ` --record-root ${shq(recordRoot)}` : ''} --agents ${agents}${tokens === null ? '' : ` --output-tokens ${tokens}`}`

/** `craft review status`: where the run stands. @param {string} bin @param {string} run @returns {string} */
export const statusCommand = (bin, run) => `${bin} review status --run ${shq(run)}`

/**
 * `craft review comment` over the run, with the pull request named and the plugin root the record is amended through.
 * @param {Where} where @param {Options} o @returns {string}
 */
export function commentCommand(where, o) {
  const recordRoot = where.recordRoot || where.root
  return `${where.bin} review comment --run ${shq(o.run)}${o.pr ? ` --pr ${o.pr}` : ''}${recordRoot ? ` --record-root ${shq(recordRoot)}` : ''}`
}
