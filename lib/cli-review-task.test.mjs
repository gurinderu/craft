// The review driver's typed tasks (lib/cli-review-task.mjs), driven end to end through the engine: the agent a
// task names, the soft fallback to the default type when that agent throws or answers nothing, and the degraded
// note the next submit hands the binary so its report says the run was weaker.
import { afterEach, beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runEngine } from './engine-harness.mjs'
import profile from '../content/profiles/rust.json' with { type: 'json' }
import nixProfile from '../content/profiles/nix.json' with { type: 'json' }

let RUN = ''
beforeEach(() => {
  RUN = mkdtempSync(join(tmpdir(), 'craft-run-'))
})
afterEach(() => {
  rmSync(RUN, { recursive: true, force: true })
})

/** A task as the binary prints it, naming `agentType`. @param {string} id @param {string} [agentType] */
const task = (id, agentType) => ({
  id,
  label: `lens:${id}`,
  model: 'opus',
  ...(agentType ? { agentType } : {}),
  promptFile: `${RUN}/tasks/${id}.md`,
  schemaFile: `${RUN}/tasks/${id}.schema.json`,
  answerFile: `${RUN}/answers/${id}.json`,
})
const FINDINGS = { lens: 'intent', findings: [] }
/** @param {unknown} value */
const ran = value => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: '' })
/** @param {object[]} tasks */
const pending = tasks => ran({ run: RUN, tasks, done: false })
/** @param {string[]} [degraded]  the notes the binary kept */
const done = degraded => ran({ run: RUN, done: true, report: `${RUN}/report.md`, verdict: 'Approve', ...(degraded ? { degraded } : {}) })
/** @typedef {{ prompt: string, opts: { agentType?: string }, callIndex: number }} ScriptCall */
/** A task agent that writes its answer file, then says done. @param {ScriptCall} c */
const writes = c => {
  const file = /to (\/\S+\.json) \(create/.exec(c.prompt)?.[1]
  assert.ok(file, c.prompt)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(FINDINGS))
  return 'done'
}
/** The task agent on `craft:rust-reviewer` fails as `fail` does; on the default type it answers. @param {(c: ScriptCall) => unknown} fail */
const failsTyped = fail => (/** @type {ScriptCall} */ c) => (c.opts.agentType ? fail(c) : writes(c))
/** The `--degraded` notes of a submit's command, unquoted. @param {string} prompt */
const notes = prompt => [...prompt.matchAll(/ --degraded '((?:[^']|'\\'')*)'/g)].map(m => String(m[1]).replaceAll("'\\''", "'"))

/** Two rounds of typed tasks, the first failing on the typed agent as `fail` does. @param {(c: ScriptCall) => unknown} fail */
const twoRounds = fail =>
  runEngine('review', {
    args: { craftBin: '/opt/craft' },
    script: {
      'step:start': pending([task('a', 'rust-reviewer'), task('v')]),
      'lens:a': failsTyped(fail),
      'lens:v': writes,
      'step:submit:1': pending([task('b', 'rust-reviewer')]),
      'lens:b': failsTyped(fail),
      'step:submit:2': done(['kept']),
    },
  })

/**
 * What every fallback test pins: each typed task ends answered on the default type, and the submits carry the notes,
 * each saying what the first failure said.
 * @param {{ calls: import('./engine-harness.mjs').Call[], report: string }} run @param {string} why
 */
function assertFellBack(run, why) {
  const lens = run.calls.filter(c => c.label === 'lens:a' || c.label === 'lens:b').map(c => [c.label, c.opts.agentType])
  assert.deepEqual(lens.at(-1), ['lens:b', undefined], 'the last typed task ends on the default type')
  assert.deepEqual(lens.filter(([l]) => l === 'lens:a').at(-1), ['lens:a', undefined], 're-run on the default type in the same round')
  assert.ok(existsSync(`${RUN}/answers/a.json`) && existsSync(`${RUN}/answers/b.json`), 'both answered')
  const submits = run.calls.filter(c => c.label.startsWith('step:submit:')).map(c => notes(c.prompt))
  assert.equal(submits.length, 2)
  for (const [i, n] of submits.entries()) {
    assert.equal(n.length, 1, `submit ${i + 1}: ${JSON.stringify(n)}`)
    assert.match(
      String(n[0]),
      new RegExp(
        `^round ${i + 1}: 1 task\\(s\\) on \`craft:rust-reviewer\` ran on the default agent type instead, without its rubric .* weaker than a normal one, not broken\\.$`,
      ),
    )
    assert.ok(String(n[0]).includes(`(the first ${why})`), String(n[0]))
  }
  assert.match(run.report, /^## Verdict\n\n✅ Approve\n.*\n\n⚠️ Degraded: part of this review ran weaker than asked/s, "the driver's answer says so too")
}

test("the profile's lens agent, named without a prefix, launches as the plugin agent the engine's Rust lenses run on", async () => {
  const run = await runEngine('review', {
    args: { craftBin: '/opt/craft' },
    script: { 'step:start': pending([task('a', profile.lensAgent), task('v')]), 'lens:a': writes, 'lens:v': writes, 'step:submit:1': done() },
  })
  const byLabel = Object.fromEntries(run.calls.map(c => [c.label, c.opts.agentType]))
  assert.equal(byLabel['lens:a'], 'craft:rust-reviewer', "the Rust lens runs on the plugin's Rust reviewer agent")
  assert.equal(byLabel['lens:a'], 'craft:rust-reviewer')
  assert.equal(byLabel['lens:v'], undefined, 'a task naming no agent runs on the default type')
  assert.ok(
    run.calls.every(c => !/--degraded/.test(c.prompt)),
    'a run that fell back on nothing submits no note',
  )
  assert.doesNotMatch(run.report, /Degraded/)
})

test("an extra lens runs on the reviewed repository's own agent, by its own name and model, with no fallback", async () => {
  const extra = { ...task('x'), consumerAgent: 'team.reviewer' }
  const run = await runEngine('review', {
    args: { craftBin: '/opt/craft' },
    script: { 'step:start': pending([extra]), 'lens:x': () => null, 'step:submit:1': done() },
  })
  const calls = run.calls.filter(c => c.label === 'lens:x')
  assert.equal(calls.length, 1, 'a dead consumer agent is not re-run on a generic one')
  const opts = /** @type {{ agentType?: string, model?: string }} */ (calls[0]?.opts ?? {})
  assert.equal(opts.agentType, 'team.reviewer')
  assert.equal(opts.model, undefined, "the agent's own model")
  assert.ok(
    run.calls.every(c => !/--degraded/.test(c.prompt)),
    'no fallback, so nothing to note: the binary names the dead lens',
  )
  const thrown = await runEngine('review', {
    args: { craftBin: '/opt/craft' },
    script: {
      'step:start': pending([extra]),
      'lens:x': () => {
        throw new Error("Agent type 'team.reviewer' not found")
      },
      'step:submit:1': done(),
    },
  })
  assert.equal(thrown.calls.filter(c => c.label === 'lens:x').length, 1)
  assert.ok(
    thrown.logs.some(l => l.includes('extra lens team.reviewer threw')),
    thrown.logs.join('\n'),
  )
  assert.match(thrown.report, /Approve/, "the run goes on to the binary's next step")
})

test("the Nix profile's lens agent launches as the plugin agent the engine's Nix lenses run on", async () => {
  const run = await runEngine('review', {
    args: { craftBin: '/opt/craft' },
    script: {
      'step:start': pending([task('n', nixProfile.lensAgent), task('r', profile.lensAgent)]),
      'lens:n': writes,
      'lens:r': writes,
      'step:submit:1': done(),
    },
  })
  const byLabel = Object.fromEntries(run.calls.map(c => [c.label, c.opts.agentType]))
  assert.equal(byLabel['lens:n'], 'craft:nix-reviewer', "the Nix lens runs on the plugin's Nix reviewer agent")
  assert.equal(byLabel['lens:n'], 'craft:nix-reviewer')
  assert.equal(byLabel['lens:r'], 'craft:rust-reviewer', "each task on its own profile's agent")
  assert.ok(
    run.calls.every(c => !/--degraded/.test(c.prompt)),
    'nothing fell back',
  )
})

test('the session Agent tool\'s "not found" wording: recognised, the type retired at once, later tasks straight to the default', async () => {
  const run = await twoRounds(() => {
    throw new Error("Agent type 'craft:rust-reviewer' not found. Available agents: general-purpose")
  })
  assertFellBack(run, 'failed with "Error: Agent type \'craft:rust-reviewer\' not found. Available agents: general-purpose"')
  assert.deepEqual(
    run.calls.filter(c => c.label === 'lens:b').map(c => c.opts.agentType),
    [undefined],
    'retired: never tried again',
  )
  assert.equal(
    run.logs.filter(l => /craft:rust-reviewer could not launch: it and every later task of this run go to the default agent type/.test(l)).length,
    1,
    run.logs.join('\n'),
  )
})

test('a typed task that returns null is re-run on the default type, each time without memory: the type is never retired', async () => {
  const run = await twoRounds(() => null)
  assertFellBack(run, 'returned nothing')
  assert.deepEqual(
    run.calls.filter(c => c.label === 'lens:b').map(c => c.opts.agentType),
    ['craft:rust-reviewer', undefined],
    'tried on the type again, then re-run',
  )
  assert.equal(run.logs.filter(l => /as craft:rust-reviewer returned no result — re-running it once/.test(l)).length, 2, run.logs.join('\n'))
  assert.ok(
    run.logs.every(l => !/could not launch/.test(l)),
    run.logs.join('\n'),
  )
})

test('a typed task that throws in wording the driver does not recognise is re-run on the default type, never left to fail', async () => {
  const run = await twoRounds(() => {
    throw new Error('subagent "craft:rust-reviewer" is unknown to this runtime')
  })
  assertFellBack(run, 'failed with "Error: subagent "craft:rust-reviewer" is unknown to this runtime"')
  assert.deepEqual(
    run.calls.filter(c => c.label === 'lens:b').map(c => c.opts.agentType),
    ['craft:rust-reviewer', undefined],
    'not retired',
  )
  assert.equal(
    run.logs.filter(l =>
      /as craft:rust-reviewer threw .* re-running this step once on the default agent type; later tasks still try craft:rust-reviewer/.test(l),
    ).length,
    2,
    run.logs.join('\n'),
  )
  assert.ok(
    run.logs.every(l => !/could not launch/.test(l)),
    run.logs.join('\n'),
  )
})

test('two concurrent failures in one round leave the typed agent to the next round; the note quotes the first, trimmed', async () => {
  const long = `transient ${'x'.repeat(300)}`
  const run = await runEngine('review', {
    args: { craftBin: '/opt/craft' },
    script: {
      'step:start': pending([task('a', 'rust-reviewer'), task('c', 'rust-reviewer')]),
      'lens:a': failsTyped(() => {
        throw new Error(long)
      }),
      'lens:c': failsTyped(() => null),
      'step:submit:1': pending([task('b', 'rust-reviewer')]),
      'lens:b': writes,
      'step:submit:2': done(),
    },
  })
  assert.deepEqual(
    run.calls.filter(c => c.label === 'lens:b').map(c => c.opts.agentType),
    ['craft:rust-reviewer'],
    'round 2 runs on the typed agent',
  )
  assert.ok(
    run.logs.every(l => !/could not launch/.test(l)),
    run.logs.join('\n'),
  )
  const submits = run.calls.filter(c => c.label.startsWith('step:submit:')).map(c => notes(c.prompt))
  assert.equal(submits[0]?.length, 1, JSON.stringify(submits))
  assert.match(
    String(submits[0][0]),
    /^round 1: 2 task\(s\) on `craft:rust-reviewer` .*\(the first (failed with "Error: transient x{140,170}"|returned nothing)\)/,
  )
  assert.deepEqual(submits[1], [], 'round 2 fell back on nothing')
})

test('an agent name this plugin does not ship runs on the default type, said once in the log and noted per round', async () => {
  const run = await runEngine('review', {
    args: { craftBin: '/opt/craft' },
    script: { 'step:start': pending([task('a', 'no-such-agent'), task('b', 'no-such-agent')]), 'lens:a': writes, 'lens:b': writes, 'step:submit:1': done() },
  })
  assert.deepEqual(
    run.calls.filter(c => c.label.startsWith('lens:')).map(c => c.opts.agentType),
    [undefined, undefined],
  )
  assert.equal(run.logs.filter(l => l.includes("task agent 'no-such-agent' is not one this plugin ships")).length, 1, run.logs.join('\n'))
  const submit = run.calls.find(c => c.label === 'step:submit:1')
  assert.deepEqual(notes(submit?.prompt ?? ''), [
    'round 1: 2 task(s) named `no-such-agent`, which this plugin does not ship, and ran on the default agent type — this run is weaker than a normal one, not broken.',
  ])
})
