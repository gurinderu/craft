// The review driver's untyped tasks (integrations/shared/cli-review-task.mjs) on craft's lean task agent, driven end to end
// through the engine: which tasks take `craft:review-task`, which keep the default type, and the soft fallback when
// the lean agent fails — re-run on the default type and said in the next submit's notes as a cost, not a weaker run.
import { afterEach, beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runEngine } from './engine-harness.mjs'

const LEAN = 'craft:review-task'
let RUN = ''
beforeEach(() => {
  RUN = mkdtempSync(join(tmpdir(), 'craft-run-'))
})
afterEach(() => {
  rmSync(RUN, { recursive: true, force: true })
})

/** A task as the binary prints it. @param {string} id @param {Record<string, unknown>} [extra] */
const task = (id, extra = {}) => ({
  id,
  label: `lens:${id}`,
  model: 'sonnet',
  kind: 'lens',
  promptFile: `${RUN}/tasks/${id}.md`,
  schemaFile: `${RUN}/tasks/${id}.schema.json`,
  answerFile: `${RUN}/answers/${id}.json`,
  ...extra,
})
/** @param {unknown} value */
const ran = value => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: '' })
/** @param {object[]} tasks */
const pending = tasks => ran({ run: RUN, tasks, done: false })
const done = () => ran({ run: RUN, done: true, report: `${RUN}/report.md`, verdict: 'Approve' })
/** @typedef {{ prompt: string, opts: { agentType?: string, model?: string }, callIndex: number }} ScriptCall */
/** A task agent that writes its answer file, then says done. @param {ScriptCall} c */
const writes = c => {
  const file = /to (\/\S+\.json) \(create/.exec(c.prompt)?.[1]
  assert.ok(file, c.prompt)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ lens: 'intent', findings: [] }))
  return 'done'
}
/** The `--degraded` notes of a submit's command, unquoted. @param {string} prompt */
const notes = prompt => [...prompt.matchAll(/ --degraded '((?:[^']|'\\'')*)'/g)].map(m => String(m[1]).replaceAll("'\\''", "'"))
/** @param {{ calls: { label: string, opts: { agentType?: string } }[] }} run @param {string} label */
const typesOf = (run, label) => run.calls.filter(c => c.label === label).map(c => c.opts.agentType)

test('a task naming no agent runs on the lean task agent, with its own model; recall and graph tasks keep the default type', async () => {
  const run = await runEngine('review', {
    args: { craftBin: '/opt/craft' },
    script: {
      'step:start': pending([
        task('g'),
        task('d', { kind: 'dedup' }),
        task('m', { graph: true }),
        task('r', { kind: 'recall' }),
        task('o', { kind: undefined }),
        task('t', { agentType: 'rust-reviewer' }),
      ]),
      'lens:g': writes,
      'lens:d': writes,
      'lens:m': writes,
      'lens:r': writes,
      'lens:o': writes,
      'lens:t': writes,
      'step:submit:1': done(),
    },
  })
  assert.deepEqual(typesOf(run, 'lens:g'), [LEAN], 'a general lens')
  assert.deepEqual(typesOf(run, 'lens:d'), [LEAN], 'the dedup')
  assert.equal(run.calls.find(c => c.label === 'lens:g')?.opts.model, 'sonnet', "the task's own model")
  assert.deepEqual(typesOf(run, 'lens:m'), [undefined], "a task asking for the code graph's MCP tools")
  assert.deepEqual(typesOf(run, 'lens:r'), [undefined], "the memory's recall needs the Skill tool and MCP servers")
  assert.deepEqual(typesOf(run, 'lens:o'), [undefined], 'a task whose kind the binary did not say')
  assert.deepEqual(typesOf(run, 'lens:t'), ['craft:rust-reviewer'], 'a typed task keeps its agent')
  assert.ok(
    run.calls.every(c => !/--degraded/.test(c.prompt)),
    'nothing fell back',
  )
})

test('the lean agent unregistered: the task re-runs on the default type, the type retires, and the note says it cost more, not less', async () => {
  const run = await runEngine('review', {
    args: { craftBin: '/opt/craft' },
    script: {
      'step:start': pending([task('a')]),
      'lens:a': (/** @type {ScriptCall} */ c) => {
        if (c.opts.agentType) throw new Error(`Agent type '${LEAN}' not found. Available agents: general-purpose`)
        return writes(c)
      },
      'step:submit:1': pending([task('b')]),
      'lens:b': writes,
      'step:submit:2': done(),
    },
  })
  assert.deepEqual(typesOf(run, 'lens:a'), [LEAN, undefined], 'tried on the lean agent, then re-run on the default type')
  assert.deepEqual(typesOf(run, 'lens:b'), [undefined], 'retired: later tasks straight to the default type')
  assert.ok(existsSync(`${RUN}/answers/a.json`) && existsSync(`${RUN}/answers/b.json`), 'both answered')
  assert.ok(
    run.logs.some(l => l.includes(`${LEAN} could not launch`)),
    run.logs.join('\n'),
  )
  const submits = run.calls.filter(c => c.label.startsWith('step:submit:')).map(c => notes(c.prompt))
  assert.equal(submits.length, 2)
  const first = submits[0] ?? []
  const second = submits[1] ?? []
  assert.equal(first.length, 1, JSON.stringify(first))
  assert.match(String(first[0]), /^round 1: 1 task\(s\) on `craft:review-task` ran on the default agent type instead \(the first failed with ".*not found/)
  assert.match(String(first[0]), /the same prompt, so no weaker, only costlier/)
  assert.doesNotMatch(String(first[0]), /without its rubric/)
  assert.match(String(second[0]), /^round 2: 1 task\(s\) on `craft:review-task` ran on the default agent type instead/)
})

test('the lean agent ships with the plugin: read-only tools, no project instructions, no pinned model', () => {
  const file = fileURLToPath(new URL('../claude-code/agents/review-task.md', import.meta.url))
  const head = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(file, 'utf8'))?.[1] ?? ''
  assert.match(head, /^name: review-task$/m)
  assert.match(head, /^tools: Read, Grep, Glob, Bash$/m)
  assert.match(head, /^omitClaudeMd: true$/m)
  assert.doesNotMatch(head, /^model:/m, 'each task passes its own model')
})
