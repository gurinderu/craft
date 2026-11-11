// What a review run tells the run store about its lenses, its verification and its cost (lib/cli-review-steps.mjs,
// lib/cli-review-record.mjs, lib/cli-review-clock.mjs, lib/cli-review-file.mjs): the engine runs in the harness with
// the binary's steps scripted — each stamped with the binary's clock and naming its phase, the last carrying the lens
// rows and the verification — telling the binary on each submit the task agents it dispatched; the binary's own filing
// of those steps is replayed through the adapter it runs into the real craft-log-run (asBinaryFiling). The run-store
// report then reads the filed record's lens yield, refutation and depth figures as it reads the engine's own record.
import { afterAll, test } from 'vitest'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run as analyzeRuns } from './analyze-runs.mjs'
import { runClock } from './cli-review-clock.mjs'
import { runEngine } from './engine-harness.mjs'
import { asBinaryFiling } from './logger-replay.mjs'

/** @type {string[]} */
const made = []
afterAll(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true })
})

/** @param {string} prefix @returns {string} */
function tmp(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  made.push(dir)
  return dir
}

/** @param {string[]} args @param {string} cwd @returns {string} */
function git(args, cwd) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}

// The binary's clock: the start ran 5 s, the scout's phase 1 min, the lenses' 5 min, the verification's 2 min.
const T0 = 1_800_000_000_000
const SEVERITY = { Critical: 0, High: 1, Medium: 0, Low: 0, Info: 0 }
const NONE = { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 }
/** The lens rows as the binary sends them, review's shape plus how many rounds sent each. */
const DIMENSIONS = [
  {
    dimension: 'rust:errors',
    ran: true,
    verdict: '',
    findingCount: 1,
    bySeverity: SEVERITY,
    confirmedCount: 1,
    suspectedCount: 0,
    refutedCount: 1,
    unverifiedCount: 0,
    rounds: 1,
  },
  {
    dimension: 'rust:tests',
    ran: true,
    verdict: '',
    findingCount: 0,
    bySeverity: NONE,
    confirmedCount: 0,
    suspectedCount: 0,
    refutedCount: 0,
    unverifiedCount: 0,
    rounds: 1,
  },
]
const VERIFICATION = { candidates: 2, confirmed: 1, refuteRate: 0.5, unverified: 0, thinned: 0, suspected: 0, refuted: 1, votes: { sent: 2, returned: 2 } }
const FINDINGS = [{ severity: 'High', file: 'src/lib.rs', line: 3, title: 't', ruleId: '', tier: 'confirmed' }]

/** The task agents a submit told the binary it had dispatched. @param {{ prompt: string }} call */
const toldAgents = call => Number(/ --agents (\d+)/.exec(call.prompt)?.[1] ?? NaN)

/** One full review over a one-commit repository, the binary's filing of its steps landing in a real store. */
async function telemetryRun() {
  const repo = tmp('craft-cli-tel-repo-')
  const store = tmp('craft-cli-tel-store-')
  const runDir = tmp('craft-cli-tel-run-')
  git(['init', '-q', '-b', 'feat/x'], repo)
  fs.writeFileSync(path.join(repo, 'lib.rs'), 'pub fn f() -> u8 { 1 }\n')
  git(['add', 'lib.rs'], repo)
  git(['commit', '-q', '-m', 'a'], repo)
  const head = git(['rev-parse', 'HEAD'], repo)
  /** @param {string} id @param {string} kind */
  const task = (id, kind) => ({
    id,
    label: `${id}:x`,
    model: 'sonnet',
    kind,
    promptFile: `${runDir}/tasks/${id}.md`,
    schemaFile: `${runDir}/tasks/${id}.schema.json`,
    answerFile: `${runDir}/answers/${id}.json`,
  })
  /** @param {Record<string, unknown>} step @param {number} at @param {number} took */
  const printed = (step, at, took) => ({ run: runDir, head, repo, ...step, at: T0 + at, took })
  const steps = [
    printed({ done: false, phase: 'scout', tasks: [task('scout', 'scout')] }, 5_000, 5_000),
    printed({ done: false, phase: 'lenses', tasks: [task('lens', 'lens')] }, 65_000, 200),
    printed({ done: false, phase: 'verify', tasks: [task('verify', 'verify')] }, 365_000, 200),
    printed(
      {
        done: true,
        report: `${runDir}/report.md`,
        verdict: 'Block',
        line: 'Block',
        base: 'origin/main',
        findings: FINDINGS,
        uncovered: [],
        notRun: [],
        dimensions: DIMENSIONS,
        verification: VERIFICATION,
        lensRounds: [{ round: 1, agents: 1, returned: 1, newFindings: 2 }],
      },
      485_000,
      300,
    ),
  ]
  /** @param {Record<string, unknown>} step */
  const ran = step => ({ exitCode: 0, stderr: '', stdout: JSON.stringify(step) })
  const engine = await runEngine('review', {
    args: { repo, craftBin: '/opt/craft' },
    script: {
      'step:start': ran(steps[0] ?? {}),
      'step:submit:1': ran(steps[1] ?? {}),
      'step:submit:2': ran(steps[2] ?? {}),
      'step:submit:3': ran(steps[3] ?? {}),
      scout: 'done',
      lens: 'done',
      verify: 'done',
    },
  })
  const told = [0, ...engine.calls.filter(c => c.label.startsWith('step:submit:')).map(toldAgents)]
  await asBinaryFiling(
    steps.map((step, i) => [step, told[i] ?? 0]),
    { repo, store, craftVersion: '0.44.0', outputTokens: 1234 },
  )
  const file = fs.readdirSync(store).find(f => f.endsWith('.json'))
  return { store, engine, told, rec: JSON.parse(fs.readFileSync(path.join(store, String(file)), 'utf8')) }
}

/**
 * The report's lines that matter here: the lens rows (a CLI row's chain mark, ` (cli)`, taken off), the workflow's
 * refutation clause and the DEPTH section's full line of its chain.
 * @param {string} store
 */
async function figures(store) {
  const out = (await analyzeRuns([store], process.env)).stdout.join('\n')
  const section = /## Dimensions[^\n]*\n((?:- [^\n]*\n?)+)/.exec(out)?.[1]?.trim() ?? ''
  const depth = /## DEPTH[^\n]*\n(?:- [^\n]*\n)*?(- full: [^\n]*)/.exec(out)?.[1] ?? ''
  return { out, dimensions: section.replaceAll(' (cli):', ':'), refute: /avg refute [0-9.]+/.exec(out)?.[0] ?? '', depth }
}

test("the filed record carries the binary's lens rows, verification and lens rounds, and the cost the driver told it", async () => {
  const { engine, told, rec } = await telemetryRun()
  assert.deepEqual([rec.dimensions, rec.verification, rec.lensRounds], [DIMENSIONS, VERIFICATION, [{ round: 1, agents: 1, returned: 1, newFindings: 2 }]])
  assert.deepEqual(told, [0, 1, 2, 3], 'each submit tells the binary the task agents dispatched so far')
  assert.deepEqual(
    rec.runtimeStats,
    { agents: 3, agentsOf: 'tasks', wallClockMinutes: 8.1, phaseMinutes: { start: 0.1, scout: 1, lenses: 5, verify: 2 } },
    'the three task agents, no service step',
  )
  assert.equal(rec.outputTokens, 1234)
  assert.deepEqual(
    engine.calls.filter(c => /^(checkpoint|log-run)/.test(c.label)),
    [],
    'no logger agent: the binary files its own telemetry',
  )
  const phases = /** @type {Array<Record<string, unknown>>} */ (rec.phases)
  assert.deepEqual(
    phases.map(p => [p['phase'], p['minutes'] ?? null, p['agents'] ?? null]),
    [
      ['start', null, null],
      ['scout', 1, 1],
      ['lenses', 5, 1],
      ['verify', 2, 1],
    ],
    'every slice folded into the one record',
  )
})

test("the record and every checkpoint, the start's first, say the CLI drove the run, so the engine's chain readers skip them", async () => {
  const { rec } = await telemetryRun()
  assert.equal(rec.driver, 'cli')
  assert.deepEqual(
    /** @type {Array<Record<string, unknown>>} */ (rec.phases).map(p => p['driver']),
    ['cli', 'cli', 'cli', 'cli'],
  )
})

// The readers keep the two chains apart (lib/run-record.mjs, reviewChain): the CLI's rows and DEPTH population are
// its own, and read the same way as the engine's.
test("analyze-runs reads a CLI record's lens yield, refutation and depth figures as it reads the engine's", async () => {
  const { store, rec } = await telemetryRun()
  const cli = await figures(store)
  assert.match(cli.out, /^- rust:errors \(cli\): /m, "the CLI's rows stay apart from the engine's")
  assert.match(cli.depth, /^- full: 1 run\(s\), agents\/run 3, wall min\/run 8\.1, confirmed\/run 1$/, cli.out)
  assert.match(cli.dimensions, /^- rust:errors: 1 finding\(s\) \/ 1 run\(s\) \(1\/run\) · H1 · refute 0\.5 \(1\/2\)/m, cli.out)
  assert.equal(cli.refute, 'avg refute 0.5')
  // The engine's record of the same run, as review files it.
  const js = tmp('craft-js-store-')
  const review = {
    schemaVersion: 1,
    runtime: 'claude-code',
    kind: 'workflow',
    name: 'review',
    craftVersion: rec.craftVersion,
    verdict: 'Block',
    depth: 'full',
    round: 1,
    findings: rec.findings,
    notRun: [],
    uncoveredFiles: [],
    outputTokens: rec.outputTokens,
    ts: rec.ts,
    dimensions: DIMENSIONS.map(({ rounds: _, ...row }) => row),
    verification: { candidates: 2, confirmed: 1, refuteRate: 0.5, unverified: 0, thinned: 0 },
    runtimeStats: { agents: rec.runtimeStats.agents, wallClockMinutes: 8.1, agentMinutes: 7, longestStallSeconds: 30, byModel: {} },
  }
  fs.writeFileSync(path.join(js, 'r.json'), JSON.stringify(review))
  const engine = await figures(js)
  assert.deepEqual([cli.dimensions, cli.refute, cli.depth], [engine.dimensions, engine.refute, engine.depth])
})

test("the clock: minutes per phase from the binary's stamps, a phase returned to adding up, none without stamps", () => {
  const clock = runClock()
  const agent = clock.counted(async () => null)
  assert.equal(clock.observe({ done: false, phase: 'verify', at: 60_000, took: 60_000 }), null, 'nothing ended at the start')
  void agent('p')
  assert.deepEqual(clock.observe({ done: false, phase: 'critic', at: 180_000, took: 1 }), { phase: 'verify', minutes: 2, agents: 1 })
  assert.deepEqual(clock.observe({ done: false, phase: 'verify', at: 240_000, took: 1 }), { phase: 'critic', minutes: 1, agents: 0 })
  assert.deepEqual(clock.observe({ done: true, at: 300_000, took: 1 }), { phase: 'verify', minutes: 3, agents: 0 })
  assert.deepEqual(clock.stats(), { agents: 1, agentsOf: 'tasks', wallClockMinutes: 5, phaseMinutes: { start: 1, verify: 3, critic: 1 } })
  const bare = runClock()
  assert.equal(bare.observe({ done: false }), null)
  assert.equal(bare.observe({ done: true }), null, 'a binary naming no phase ends none')
  assert.deepEqual(bare.stats(), { agents: 0, agentsOf: 'tasks' }, 'no stamps: the minutes are left out, never zero')
})

test('once the usage limit is seen a task the watch answers without dispatching is not counted in runtimeStats.agents', async () => {
  const RUN = '/tmp/craft-run-limit'
  /** @param {string} id */
  const task = id => ({
    id,
    label: `lens:${id}`,
    model: 'sonnet',
    kind: 'lens',
    promptFile: `${RUN}/tasks/${id}.md`,
    schemaFile: `${RUN}/tasks/${id}.schema.json`,
    answerFile: `${RUN}/answers/${id}.json`,
  })
  /** @param {Record<string, unknown>} step */
  const ran = step => ({ exitCode: 0, stderr: '', stdout: JSON.stringify({ run: RUN, ...step }) })
  const run = await runEngine('review', {
    args: { repo: '/work/repo', craftBin: '/opt/craft' },
    script: {
      'step:start': ran({ done: false, tasks: [task('a'), task('b')] }),
      lens: () => {
        throw new Error("You've hit your limit · resets 3am (Europe/Berlin)")
      },
      // A step after the stop hands out one more task, which the watch answers without a dispatch.
      'step:submit:1': ran({ done: false, tasks: [task('c')] }),
      'step:submit:2': ran({ done: true, report: `${RUN}/report.md`, verdict: 'INCOMPLETE', line: 'INCOMPLETE' }),
    },
  })
  assert.deepEqual(
    run.calls.filter(c => c.label.startsWith('lens:')).map(c => c.label),
    ['lens:a', 'lens:b'],
    'lens:c never dispatched',
  )
  assert.deepEqual(run.calls.filter(c => c.label.startsWith('step:submit:')).map(toldAgents), [2, 2], 'only the two dispatched task agents are told')
})
