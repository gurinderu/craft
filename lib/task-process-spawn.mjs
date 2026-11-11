// A child process of a process-per-task review driver (lib/task-process-run.mjs; realm @nick/craft, node #453): the
// `craft` binary's commands, run through sh as the Claude Code driver's service agent runs them, and each task's own
// agent process. What it printed comes back whole, in the shape the step readers take (lib/cli-review-step.mjs,
// commandOutput), with whether its deadline cut it off.
import { spawn } from 'node:child_process'

/** @typedef {{ exitCode: number, stdout: string, stderr: string, timedOut: boolean }} Ran */
/** @typedef {{ cwd?: string, env?: NodeJS.ProcessEnv, stdin?: string, timeoutMs?: number }} RunOpts */

// How long a process cut off at its deadline gets to exit on SIGTERM before it is killed.
const KILL_GRACE_MS = 5000
// The exit a process that could not be started reports, as a shell reports a command it cannot find.
const NOT_STARTED = 127

/**
 * `file` run with `args`, `stdin` written to it, cut off once `timeoutMs` (0: never) has passed.
 * @param {string} file @param {string[]} args @param {RunOpts} [opts] @returns {Promise<Ran>}
 */
export function runProcess(file, args, { cwd, env, stdin = '', timeoutMs = 0 } = {}) {
  return new Promise(resolve => {
    const child = spawn(file, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    /** @type {Buffer[]} */
    const out = []
    /** @type {Buffer[]} */
    const err = []
    let timedOut = false
    /** @type {NodeJS.Timeout | undefined} */
    let kill
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      kill = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
    }, timeoutMs) : undefined
    child.stdout.on('data', b => out.push(b))
    child.stderr.on('data', b => err.push(b))
    /** @param {number} exitCode @param {string} [extra] */
    const done = (exitCode, extra = '') => {
      clearTimeout(timer)
      clearTimeout(kill)
      resolve({ exitCode, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') + extra, timedOut })
    }
    child.on('error', e => done(NOT_STARTED, `${file}: ${e.message}`))
    child.on('close', (code, signal) => done(code ?? (signal ? 128 : 1)))
    // A child that exits before reading its stdin closes the pipe: that is its answer, not the driver's error.
    child.stdin.on('error', () => {})
    child.stdin.end(stdin)
  })
}

/** A shell command line, run through sh. @param {string} line @param {RunOpts} [opts] @returns {Promise<Ran>} */
export const runShell = (line, opts) => runProcess('/bin/sh', ['-c', line], opts)
