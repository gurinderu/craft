// What a run stopped by lib/usage-limit.mjs tells a human, and how a parent reads a nested run's stop
// back from its report (realm @nick/craft, nodes #299, #300). Imported by lib/review-run-report.mjs
// (review), src/adversarial-review.js and src/rust-audit.js.

import { usageLimitText } from './usage-limit.mjs'

/**
 * The logger as a human runs it: CLAUDE_PLUGIN_ROOT, else this version's installed copy. Never a
 * craftRoot from the run's arguments, which a model composed: the advice is pasted into a shell.
 * @param {string} version
 * @returns {string}
 */
export function loggerCommand(version) {
  return `node "\${CLAUDE_PLUGIN_ROOT:-\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/craft/craft/${shellSafe(version)}}"/lib/craft-log-run.mjs`
}

/** A version as it may stand inside double quotes: digits, letters, dots and dashes only. @param {string} v */
export function shellSafe(v) {
  return String(v ?? '').replace(/[^\w.-]/g, '')
}

/**
 * What a human does about a run stopped at the usage limit, '' when it was not. The logger shares the
 * account, so the record may be lost to the same limit. An engine that writes phase checkpoints
 * (review) leaves them in `.partial` for `recover`; one that writes none has nothing to recover from,
 * and the honest advice is to rerun it.
 * @param {{ seen: () => string, note: () => string }} stop  a makeLimitStop
 * @param {{ version: string, engine: string, checkpoints: boolean }} o
 * @returns {string}
 */
export function limitStopAdvice(stop, { version, engine, checkpoints }) {
  if (!stop.seen()) return ''
  const cmd = loggerCommand(version)
  const recovery = checkpoints
    ? `if it is reported lost, run this in the reviewed repository once the limit resets, to promote this run's .partial checkpoints into a partial record: \`${cmd} recover\``
    : `if it is reported lost, this run's record could not be written (${engine} writes no checkpoints): rerun the ${engine === 'rust-audit' ? 'audit' : 'review'} after the limit resets`
  return `${stop.note()}. The run record was attempted, but its logger runs on the same account; ${recovery}`
}

/**
 * The limit message a nested review's report says it stopped on, or '': the parent reads the child's
 * stop from the child's own words (`stopped: usage limit reached (<text>)`), not from its length.
 * @param {unknown} report
 * @returns {string}
 */
export function limitInReport(report) {
  const m = /stopped: usage limit reached \((.+?)\)(?=[.;:,]|\s|$)/m.exec(typeof report === 'string' ? report : '')
  return m ? usageLimitText(m[1]) : ''
}

/**
 * The death streak a nested review's report says it stopped on (`stopped: <n> agents in a row died with
 * no answer`), or '': the parent takes it as its own stop, so a dead account is not dispatched into again.
 * @param {unknown} report
 * @returns {string}
 */
export function deathsInReport(report) {
  const m = /stopped: (\d+ agents in a row died with no answer)/m.exec(typeof report === 'string' ? report : '')
  return m ? String(m[1]) : ''
}
