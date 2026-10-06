// The gate is complete (lib/gate.mjs): every check this repository names — a package.json script, a
// lib/check-*.mjs, a command in CI's `test` job or in AGENTS.md "Commands" — is a gate step or is in EXCLUDED
// with its reason; dropping any one step leaves a named check uncovered. And the gate runs every step, a
// failed one included.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { EXCLUDED, STEPS, run } from './gate.mjs'

/** @typedef {import('./gate.mjs').Step} Step */

const REPO = path.resolve(import.meta.dirname, '..')
/** @param {string} rel */
const read = rel => fs.readFileSync(path.join(REPO, rel), 'utf8')
const SCRIPTS = /** @type {Record<string, string>} */ (/** @type {{ scripts: unknown }} */ (JSON.parse(read('package.json'))).scripts)
const KNOWN_COMMANDS = ['npm ci', 'npm audit', 'semgrep', 'plugin validate']

/** The checks a command line names, as keys. @param {string} text @returns {string[]} */
function keysOf(text) {
  const keys = new Set()
  for (const m of text.matchAll(/\bnpm (?:run (?:--silent )?([\w:-]+)|(test)\b)/g)) keys.add(`script:${m[1] ?? m[2] ?? ''}`)
  for (const m of text.matchAll(/\bnode (lib\/[\w.-]+\.mjs)/g)) keys.add(`file:${m[1] ?? ''}`)
  for (const cmd of KNOWN_COMMANDS) if (text.includes(cmd)) keys.add(`cmd:${cmd}`)
  // Longest body first, each match removed: `knip --no-progress` must not match inside `knip --no-progress --production`.
  let rest = text
  for (const [name, body] of Object.entries(SCRIPTS).sort((a, b) => b[1].length - a[1].length)) {
    if (rest.includes(body)) { keys.add(`script:${name}`); rest = rest.split(body).join(' ') }
  }
  return [...keys]
}

/** @param {string} line */
const indent = line => line.length - line.trimStart().length

/** Every `run:` of CI's `test` job, a block scalar joined. @returns {string[]} */
function ciTestRuns() {
  const lines = read('.github/workflows/ci.yml').split('\n')
  const start = lines.indexOf('  test:')
  assert.notEqual(start, -1, 'ci.yml has no `test` job')
  const end = lines.findIndex((l, i) => i > start && /^ {2}\S/.test(l))
  const job = lines.slice(start, end === -1 ? undefined : end)
  /** @type {string[]} */
  const runs = []
  job.forEach((line, i) => {
    const m = /^(\s*)run: ?(.*)$/.exec(line)
    if (!m) return
    const head = m[2] ?? ''
    if (!/^[|>]/.test(head)) { runs.push(head); return }
    const body = []
    for (const next of job.slice(i + 1)) { if (next.trim() && indent(next) <= (m[1] ?? '').length) break; body.push(next) }
    runs.push(body.join('\n'))
  })
  return runs
}

/** The command cell of each row of AGENTS.md "Commands". @returns {string[]} */
function agentsCommands() {
  const text = read('AGENTS.md')
  const section = text.slice(text.indexOf('\n## Commands\n'), text.indexOf('\n## ', text.indexOf('\n## Commands\n') + 1))
  return section.split('\n').filter(l => l.startsWith('| ') && !l.startsWith('| What')).map(l => l.split('|').at(-2) ?? '')
}

/** Every check the gate must run or exclude. @returns {Set<string>} */
function required() {
  const keys = new Set(Object.keys(SCRIPTS).map(s => `script:${s}`))
  for (const f of fs.readdirSync(path.join(REPO, 'lib'))) if (/^check-.*\.mjs$/.test(f) && !f.endsWith('.test.mjs')) keys.add(`file:lib/${f}`)
  for (const block of ciTestRuns()) {
    const found = keysOf(block)
    for (const k of found.length ? found : [`ci.yml: an unrecognised command: ${block.trim().split('\n')[0] ?? ''}`]) keys.add(k)
  }
  for (const cell of agentsCommands()) for (const k of keysOf(cell)) keys.add(k)
  return keys
}

/** A step covers what its command line names, and what the script it runs names. @param {Step} step @param {string} key */
function covers(step, key) {
  const ran = keysOf([step.cmd, ...step.args].join(' '))
  return ran.includes(key) || ran.some(k => k.startsWith('script:') && keysOf(SCRIPTS[k.slice('script:'.length)] ?? '').includes(key))
}

/** @param {Step[]} steps @returns {string[]} */
const uncovered = steps => [...required()].filter(k => !Object.hasOwn(EXCLUDED, k) && !steps.some(s => covers(s, k)))

test('the gate: every check named in package.json, lib/, ci.yml and AGENTS.md is a step or excluded with a reason', () => {
  assert.deepEqual(uncovered(STEPS), [])
})

test('the gate: an exclusion names a check that exists, and no step repeats', () => {
  const req = required()
  assert.deepEqual(Object.keys(EXCLUDED).filter(k => !req.has(k)), [], 'a stale exclusion')
  assert.equal(new Set(STEPS.map(s => s.name)).size, STEPS.length)
})

test('the gate: dropping any one step leaves a check uncovered', () => {
  for (const step of STEPS) assert.notDeepEqual(uncovered(STEPS.filter(s => s !== step)), [], `${step.name} covers nothing required`)
})

/** @param {(cmd: string, args: string[]) => number} status */
function recorder(status) {
  /** @type {string[]} */
  const ran = []
  /** @type {import('./gate.mjs').Exec} */
  const exec = (cmd, args, quiet) => { if (!quiet) ran.push([cmd, ...args].join(' ')); return status(cmd, args) }
  return { ran, exec }
}

test('run: every step runs though one fails; the failure is named and the exit is 1', async () => {
  const { ran, exec } = recorder((_c, args) => (args.includes('lint') ? 2 : 0))
  const r = await run([], process.env, exec, () => 0)
  assert.equal(r.exitCode, 1)
  assert.equal(ran.length, STEPS.length)
  assert.deepEqual(r.stderr, ['gate: FAIL lint (exit 2, 0s)', `gate: 1 of ${STEPS.length} steps failed: lint`])
})

test('run: all steps pass; the mutation floor is compared with --base, else origin/main when it resolves, else none', async () => {
  const floor = (/** @type {string[]} */ ran) => ran.find(l => l.includes('check-mutation-floor'))
  const given = recorder(() => 0)
  const r = await run(['--base', 'abc'], process.env, given.exec, () => 0)
  assert.equal(r.exitCode, 0)
  assert.equal(r.stdout.at(-1), `gate: all ${STEPS.length} steps passed`)
  assert.equal(floor(given.ran), 'node lib/check-mutation-floor.mjs --base abc')
  const found = recorder(() => 0)
  await run([], process.env, found.exec, () => 0)
  assert.equal(floor(found.ran), 'node lib/check-mutation-floor.mjs --base origin/main')
  const none = recorder(cmd => (cmd === 'git' ? 1 : 0))
  await run([], process.env, none.exec, () => 0)
  assert.equal(floor(none.ran), 'node lib/check-mutation-floor.mjs')
})
