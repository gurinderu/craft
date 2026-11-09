// Test infrastructure: what the logger agent runs, and what the craft binary's telemetry runs, replayed through the
// real craft-log-run CLI. An engine test hands
// a logger dispatch's prompt here, and the checkpoint or record it asks for lands in a real store from a real git
// checkout — so a test reads the index line a live run would file, not the payload the engine sent.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run } from './craft-log-run.mjs'
import { run as fileRun } from './cli-review-file.mjs'

/**
 * The `node "$CRAFT_LOGGER" <command> <flags>` line of the prompt, with the payload the prompt carries on stdin,
 * run in `repo` against `store`; answered as the logger agent answers a checkpoint (its runDir) or a record.
 * @param {string} prompt @param {string} repo @param {string} store
 * @returns {Promise<{ runDir: string, error: string } | { ok: boolean, error?: string }>}
 */
export async function asLogger(prompt, repo, store) {
  // The session flag is shell-expanded from an unset variable here, so it expands to nothing.
  const line = (/node "\$CRAFT_LOGGER" (.*?)--project "\$PWD"/.exec(prompt)?.[1] ?? '').replace(/\$\{[^}]*\}/g, '')
  const argv = [...line.matchAll(/'((?:[^']|'\\'')*)'|(\S+)/g)].map(m => m[1] != null ? m[1].replace(/'\\''/g, "'") : String(m[2]))
  const payload = prompt.split(/\n(?:PAYLOAD|RECORD):\n/)[1] ?? 'null'
  const r = await run([...argv, '--store', store, '--project', repo], {}, repo, () => payload)
  if (r.exitCode !== 0) return argv[0] === 'checkpoint' ? { runDir: '', error: r.stderr.join('\n') } : { ok: false, error: r.stderr.join('\n') }
  return argv[0] === 'checkpoint' ? { runDir: JSON.parse(String(r.stdout[0])).runDir, error: '' } : { ok: true }
}

/** @typedef {{ done?: boolean, phase?: string, at?: number, took?: number }} Printed  a step as the binary printed it */
/** @typedef {{ done: boolean, phase: string, at: number | null, took: number | null, agents: number }} Told */

/** `step` as the binary keeps it. @param {Printed} step @param {number} agents @returns {Told} */
const told = (step, agents) => ({ done: step.done === true, phase: String(step.phase ?? ''), at: step.at ?? null, took: step.took ?? null, agents })

/**
 * The writes the binary makes after `step`, its steps kept so far ending in it: the start checkpoint after the first,
 * after any other the checkpoint of a phase it may have ended — the adapter's clock replay decides, answering
 * `skipped` when none ended — and the record after the finished one.
 * @param {Told[]} steps @param {Printed & Record<string, unknown>} step @returns {Array<[string, Record<string, unknown>]>}
 */
function writesAfter(steps, step) {
  /** @type {Array<[string, Record<string, unknown>]>} */
  const writes = [['checkpoint', { start: steps.length === 1, head: String(step['head'] ?? '') }]]
  if (step.done === true) writes.push(['finalize', { step, retry: false }])
  return writes
}

/**
 * What the craft binary's telemetry does over a run's steps (cli/crates/craft-review/src/filing.rs), replayed through
 * the adapter it runs (lib/cli-review-file.mjs) into `store`. Each step goes with the task agents dispatched by then;
 * the run's own fields — depth, strict, via, output tokens — as the binary keeps them.
 * @param {Array<[Printed & Record<string, unknown>, number]>} printed
 * @param {{ repo: string, store: string, craftVersion: string, depth?: string, strict?: boolean, via?: string, outputTokens?: number | null }} run
 * @returns {Promise<Array<Record<string, unknown>>>} each answer the adapter gave
 */
export async function asBinaryFiling(printed, { repo, store, craftVersion, depth = 'full', strict = false, via = '', outputTokens = null }) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-filing-'))
  /** @type {Told[]} */
  const steps = []
  /** @type {Array<Record<string, unknown>>} */
  const answers = []
  let dir = ''
  try {
    for (const [step, agents] of printed) {
      steps.push(told(step, agents))
      for (const [command, req] of writesAfter(steps, step)) {
        const input = path.join(scratch, `${answers.length}.json`)
        fs.writeFileSync(input, JSON.stringify({ repo, craftVersion, session: '', dir, rejoin: false, steps, head: '', depth, strict, via, outputTokens, ...req }))
        const answer = JSON.parse(String((await fileRun([command, '--input', input, '--store', store])).stdout.at(-1)))
        if (typeof answer.runDir === 'string') dir = answer.runDir
        answers.push(answer)
      }
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
  return answers
}
