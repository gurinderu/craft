// The gate as one call: `npm run gate` runs every offline check this repository holds a change to, and CI's
// `test` job calls the same command, so a check dropped from it is dropped everywhere at once — and
// lib/gate-steps.test.mjs fails when a check named in package.json, lib/check-*.mjs, AGENTS.md "Commands" or
// the CI job is neither a step here nor in EXCLUDED with its reason.
//
// Every step runs, a failed one included: one red step must not hide the verdict of the rest. Each prints its
// own output, then one result line; the exit code is 1 when any step failed.
//
// Run: `npm run gate` (needs `npm ci` and `npm ci --prefix opencode/plugin`), or `npm run gate -- --base <ref>`
// to compare the mutation floor with that ref; without `--base`, `origin/main` when it resolves, else none.
import { spawnSync } from 'node:child_process'
import { outputLines, runIfMain } from './script-main.mjs'

/** @typedef {{ name: string, cmd: string, args: string[] }} Step */
/** @typedef {(cmd: string, args: string[], quiet: boolean) => number | null} Exec */

/** @param {string} script @returns {Step} */
const npmRun = script => ({ name: script, cmd: 'npm', args: ['run', '--silent', script] })

/** @type {Step[]} */
export const STEPS = [
  npmRun('lint'),
  npmRun('check:types'),
  npmRun('check:types:lib'),
  npmRun('check:types:workflows'),
  { name: 'test', cmd: 'npm', args: ['test'] },
  npmRun('check:workflows'),
  npmRun('check:workflow-size'),
  npmRun('check:skills'),
  { name: 'check-delivery-parity', cmd: 'node', args: ['lib/check-delivery-parity.mjs'] },
  npmRun('check:opencode-frontmatter'),
  npmRun('check:evals'),
  npmRun('check:deps'),
  npmRun('check:dead:production'),
  npmRun('check:dead'),
  npmRun('check:dup'),
  { name: 'check-mutation-floor', cmd: 'node', args: ['lib/check-mutation-floor.mjs'] },
  { name: 'plugin validate --strict', cmd: 'npx', args: ['--yes', '@anthropic-ai/claude-code', 'plugin', 'validate', '.', '--strict'] },
]

/** What is deliberately not a step, keyed as lib/gate-steps.test.mjs keys a command, with the reason. */
export const EXCLUDED = {
  'script:gate': 'the gate itself',
  'script:test:mutation': 'Stryker rewrites lib/ in place for many minutes; the weekly mutation workflow runs it, and its floor is the check-mutation-floor step',
  'script:check:dup:baseline': 'regenerates .jscpd-baseline.json — a fix, not a check; check:dup holds its result',
  'cmd:npm audit': 'needs the network and is not reproducible (realm @nick/craft, #141): its own steps in CI\'s test job',
  'cmd:semgrep': 'its own CI job in a pinned image, rules fetched from the registry per run (realm @nick/craft, #138)',
  'file:lib/quality-delta.mjs': 'a signal between two checkouts, never a gate: CI\'s quality-delta job',
  'cmd:npm ci': 'installs, not a check: the gate needs both installs before it runs',
}

/** @type {Exec} */
function spawnStep(cmd, args, quiet) {
  return spawnSync(cmd, args, { stdio: quiet ? 'ignore' : 'inherit' }).status
}

/** The base for the mutation floor: `--base <ref>` given, else origin/main when it resolves, else none. @param {string[]} argv @param {Exec} exec */
function baseOf(argv, exec) {
  const i = argv.indexOf('--base')
  if (i !== -1) return argv[i + 1] ?? ''
  return exec('git', ['rev-parse', '--verify', '--quiet', 'origin/main^{commit}'], true) === 0 ? 'origin/main' : null
}

/** @param {Step} step @param {string | null} base @returns {Step} */
function withBase(step, base) {
  return step.name === 'check-mutation-floor' && base !== null ? { ...step, args: [...step.args, '--base', base] } : step
}

/** @param {number} ms */
const seconds = ms => `${Math.round(ms / 1000)}s`

/**
 * The command (realm @nick/craft, #172).
 * @param {string[]} argv  `--base <ref>` or nothing
 * @param {NodeJS.ProcessEnv} _env  unused: each step inherits the process environment
 * @param {Exec} [exec]  runs one command, its output through; returns its exit status
 * @param {() => number} [now]
 * @returns {Promise<import('./script-main.mjs').ScriptResult>}
 */
export async function run(argv, _env, exec = spawnStep, now = Date.now) {
  const { stdout, stderr } = outputLines()
  const base = baseOf(argv, exec)
  const failed = []
  for (const step of STEPS.map(s => withBase(s, base))) {
    stdout.push(`gate: ▶ ${step.name} — ${[step.cmd, ...step.args].join(' ')}`)
    const start = now()
    const status = exec(step.cmd, step.args, false)
    const took = seconds(now() - start)
    if (status === 0) stdout.push(`gate: PASS ${step.name} (${took})`)
    else { failed.push(step.name); stderr.push(`gate: FAIL ${step.name} (exit ${status ?? 'signal'}, ${took})`) }
  }
  stdout.push(`gate: mutation floor compared with ${base ?? 'no base (none given, origin/main not found)'}`)
  for (const [key, why] of Object.entries(EXCLUDED)) stdout.push(`gate: not a step — ${key}: ${why}`)
  if (failed.length) {
    stderr.push(`gate: ${failed.length} of ${STEPS.length} steps failed: ${failed.join(', ')}`)
    return { exitCode: 1, stdout, stderr }
  }
  stdout.push(`gate: all ${STEPS.length} steps passed`)
  return { exitCode: 0, stdout, stderr }
}

await runIfMain(import.meta.url, run)
