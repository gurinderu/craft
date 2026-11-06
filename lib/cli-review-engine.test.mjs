// The cli-review engine (src/cli-review.js, lib/cli-review-steps.mjs) driven end to end with scripted agents: the
// service agent's command output stands in for the `craft` binary, and each scripted task agent writes its answer
// file in a temporary run directory as a real one would; the scripted submit reads those files back, as the binary
// does. What is pinned is the driver's loop — start, the step's tasks told where their files are, submit, done, the
// verdict and the report's path — and that no prompt, schema, answer or report passes through a model's copy.
import { afterEach, beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { CALL_SPEND, runEngine } from './engine-harness.mjs'

let RUN = ''
beforeEach(() => { RUN = mkdtempSync(join(tmpdir(), 'craft-run-')) })
afterEach(() => { rmSync(RUN, { recursive: true, force: true }) })

/** The task as the binary prints it: its files in the run directory. @param {string} id @param {string} label @param {string} model */
const task = (id, label, model) => ({
  id, label, model,
  promptFile: `${RUN}/tasks/${id}.md`, schemaFile: `${RUN}/tasks/${id}.schema.json`, answerFile: `${RUN}/answers/${id}.json`,
})
const lens = () => task('lens-intent', 'lens:intent', 'opus')
const verify = () => task('verify-0', 'verify:src/a.rs:3', 'sonnet')
const FINDINGS = { lens: 'intent', findings: [{ severity: 'High', title: 't', file: 'src/a.rs', line: 3 }] }
const VERDICT = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'seen' }

/** A service agent's answer carrying `value` as the command's stdout. @param {unknown} value */
const ran = value => ({ exitCode: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' })
/** @param {object[]} tasks */
const pending = tasks => ran({ run: RUN, tasks, done: false })
const done = () => ran({ run: RUN, done: true, report: `${RUN}/report.md`, verdict: 'Block' })
/** The resolve step's answer: the plugin root the fetcher was found in, and the released binary's path. */
const FETCHED = '/home/u/.craft/bin/0.40.1/craft'
const PLUGIN = '/home/u/.claude/plugins/cache/craft/craft/0.40.1'
const resolved = () => ran(`root=${PLUGIN}\nbin=${FETCHED}\n`)

/** A scripted task agent: writes `answer` to the answer file its prompt names, then says done. @param {unknown} answer */
const writes = answer => (/** @type {{ prompt: string }} */ { prompt }) => {
  const file = /to (\/\S+\.json) \(create/.exec(prompt)?.[1]
  assert.ok(file, prompt)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(answer))
  return 'done'
}
/** The answer file of task `id` as the binary would read it. @param {string} id @returns {unknown} */
const answerOf = id => JSON.parse(readFileSync(`${RUN}/answers/${id}.json`, 'utf8'))

test('one full loop: start, the lens, its findings verified, done, the report by its path — all through files', async () => {
  /** @type {unknown[]} */
  const seen = []
  const run = await runEngine('cli-review', {
    args: { repo: '/work/repo', base: 'origin/main', craftBin: '/opt/craft' },
    script: {
      'step:start': pending([lens()]),
      lens: writes(FINDINGS),
      'step:submit:1': () => { seen.push(answerOf('lens-intent')); return pending([verify()]) },
      verify: writes(VERDICT),
      'step:submit:2': () => { seen.push(answerOf('verify-0')); return done() },
    },
  })
  assert.deepEqual(run.calls.map(c => c.label), ['step:start', 'lens:intent', 'step:submit:1', 'verify:src/a.rs:3', 'step:submit:2'])
  assert.deepEqual(seen, [FINDINGS, VERDICT], 'each answer reached the binary as the file its agent wrote')
  const [start, lensCall, submit1] = run.calls.map(c => ({ prompt: c.prompt, opts: c.opts }))
  assert.ok(start && lensCall && submit1)
  assert.match(start.prompt, /^Run exactly this one command:\n\n'\/opt\/craft' review start --cwd '\/work\/repo' --base 'origin\/main'$/m)
  assert.equal(start.opts.agentType, 'craft:engine-service')
  assert.equal(lensCall.prompt, `Read the file ${RUN}/tasks/lens-intent.md and do exactly what it says. When done, write your final answer as JSON matching the schema in ${RUN}/tasks/lens-intent.schema.json to ${RUN}/answers/lens-intent.json (create the directory if needed), then reply with the single word done.`)
  assert.deepEqual([lensCall.opts.model, lensCall.opts.schema, lensCall.opts.agentType], ['opus', undefined, undefined], 'the model the binary named, no schema, the default type')
  assert.equal(submit1.prompt.split('\n\n')[1], `'/opt/craft' review submit --run '${RUN}'`)
  assert.doesNotMatch(submit1.prompt, /findings|--answers/, 'no answer passes through the service agent')
  assert.equal(run.report, `Verdict: Block (run ${RUN})\n\nThe report is ${RUN}/report.md — read that file for the findings.`, 'the report is named by its path, never copied by a model')
  assert.deepEqual(run.phases, ['Start', 'Agents', 'Submit', 'Agents', 'Submit'])
  assert.ok(run.logs.some(l => l === 'round 1: 1 task(s) — lens:intent'), run.logs.join('\n'))
})

test('a dead agent writes no file; the retry the binary hands back runs again on the task\'s own agent type', async () => {
  const typed = { ...lens(), agentType: 'craft:rust-reviewer' }
  /** @type {boolean[]} */
  const fileAtSubmit = []
  const run = await runEngine('cli-review', {
    args: {},
    script: {
      'step:resolve': resolved(),
      'step:start': pending([typed]),
      lens: (/** @type {{ callIndex: number, prompt: string }} */ c) => (c.callIndex === 0 ? null : writes(FINDINGS)(c)),
      'step:submit:1': () => { fileAtSubmit.push(existsSync(typed.answerFile)); return pending([typed]) },
      'step:submit:2': () => { fileAtSubmit.push(existsSync(typed.answerFile)); return done() },
    },
  })
  assert.deepEqual(fileAtSubmit, [false, true])
  const lensCalls = run.calls.filter(c => c.label === 'lens:intent')
  assert.deepEqual(lensCalls.map(c => c.opts.agentType), ['craft:rust-reviewer', 'craft:rust-reviewer'])
  assert.equal(run.calls[0]?.label, 'step:resolve')
  assert.match(run.calls[1]?.prompt ?? '', /^'\/home\/u\/\.craft\/bin\/0\.40\.1\/craft' review start --cwd \. --craft-root '\/home\/u\/\.claude\/plugins\/cache\/craft\/craft\/0\.40\.1'$/m, 'the fetched path runs every step, told the plugin root it cannot find above itself')
  assert.match(run.report, /^Verdict: Block/)
})

test('a step that cannot be read ends the run INCOMPLETE, never as a verdict', async () => {
  const failed = await runEngine('cli-review', {
    args: {},
    script: { 'step:resolve': resolved(), 'step:start': { exitCode: 1, stdout: '', stderr: 'craft: the base nope is not a commit' } },
  })
  assert.match(failed.report, /^INCOMPLETE — cli-review stopped at round 1: the command exited 1: craft: the base nope is not a commit/)
  const garbled = await runEngine('cli-review', { args: {}, script: { 'step:resolve': resolved(), 'step:start': ran('{"run": "/tmp/x", "tasks": [') } })
  assert.match(garbled.report, /^INCOMPLETE — .*printed no JSON/)
  const relative = await runEngine('cli-review', { args: {}, script: { 'step:resolve': resolved(), 'step:start': pending([{ ...lens(), answerFile: 'answers/x.json' }]) } })
  assert.match(relative.report, /^INCOMPLETE — .*no well-formed tasks/, 'a task file that is not an absolute path is refused')
  const refused = await runEngine('cli-review', { args: { craftBin: 'craft' }, script: {} })
  assert.match(refused.report, /^INCOMPLETE — cli-review: craftBin="craft" is not an absolute path\. Nothing ran\./)
  assert.equal(refused.calls.length, 0)
})

test('a spent budget fails the run closed rather than reporting a verdict', async () => {
  const script = { 'step:resolve': resolved(), 'step:start': pending([lens()]), lens: writes(FINDINGS), 'step:submit:1': done() }
  await assert.rejects(runEngine('cli-review', { args: {}, script, budgetTotal: CALL_SPEND * 2 }), /budget exhausted/)
})

test('without craftBin the released binary of this version is fetched first, the fetcher located like the logger', async () => {
  const run = await runEngine('cli-review', {
    args: { repo: '/work/repo', craftRoot: '/opt/craft-plugin' },
    script: { 'step:resolve': resolved(), 'step:start': done() },
  })
  assert.deepEqual(run.calls.map(c => c.label), ['step:resolve', 'step:start'])
  const fetch = run.calls[0]
  assert.ok(fetch)
  assert.deepEqual([fetch.opts.agentType, fetch.opts.model, fetch.opts.phase], ['craft:engine-service', 'haiku', 'Start'])
  assert.match(fetch.prompt, /CRAFT_TRY='\/opt\/craft-plugin'"\/lib\/craft-bin\.mjs"/, 'craftRoot first')
  assert.match(fetch.prompt, /\$\{CLAUDE_PLUGIN_ROOT:-\}\/lib\/craft-bin\.mjs/, 'then the plugin root')
  assert.match(fetch.prompt, /plugins\/cache\/craft\/craft\/"'\d+\.\d+\.\d+'"\/lib\/craft-bin\.mjs/, 'then this version\'s installed copy')
  assert.match(fetch.prompt, /node "\$CRAFT_FETCHER" ensure --version '\d+\.\d+\.\d+'/, 'the engine\'s own stamp')
  assert.match(fetch.prompt, /printf 'root=%s\\nbin=%s\\n' "\$\(dirname "\$\(dirname "\$CRAFT_FETCHER"\)"\)" "\$CRAFT_BIN_PATH"/, 'the root the fetcher was found in, beside the binary')
  assert.match(fetch.prompt, /stdout is two lines, root=<the plugin root> and bin=<the binary's path>, the caller parses/)
  assert.equal(run.calls[1]?.prompt.split('\n\n')[1], `'${FETCHED}' review start --cwd '/work/repo' --craft-root '${PLUGIN}'`, 'start gets the root the step printed')
  assert.match(run.report, /^Verdict: Block/)
})

test('a fetch that fails or prints no absolute path ends the run INCOMPLETE before any step', async () => {
  const failed = await runEngine('cli-review', {
    args: {},
    script: { 'step:resolve': { exitCode: 1, stdout: '', stderr: 'craft-bin: no released craft binary for win32/x64' } },
  })
  assert.match(failed.report, /^INCOMPLETE — cli-review could not get the craft binary [\d.]+: the command exited 1: craft-bin: no released craft binary for win32\/x64\. Pass craftBin=/)
  assert.deepEqual(failed.calls.map(c => c.label), ['step:resolve'])
  const relative = await runEngine('cli-review', { args: {}, script: { 'step:resolve': ran(`root=${PLUGIN}\nbin=craft\n`) } })
  assert.match(relative.report, /^INCOMPLETE — .*the fetch printed no absolute root= and bin= lines: root=/)
  assert.deepEqual(relative.calls.map(c => c.label), ['step:resolve'])
  const rootless = await runEngine('cli-review', { args: {}, script: { 'step:resolve': ran(`${FETCHED}\n`) } })
  assert.match(rootless.report, /^INCOMPLETE — .*no absolute root= and bin= lines/, 'a binary path without the root is not enough')
})

test('with craftBin, start gets --craft-root only when craftRoot is given and checked; otherwise the binary looks above itself', async () => {
  const given = await runEngine('cli-review', {
    args: { repo: '/work/repo', craftBin: '/opt/craft', craftRoot: '/opt/craft-plugin' },
    script: { 'step:root': ran('root=/srv/craft-plugin\n'), 'step:start': done() },
  })
  assert.deepEqual(given.calls.map(c => c.label), ['step:root', 'step:start'], 'no fetch when craftBin is given, only the root checked')
  const rootStep = given.calls[0]
  assert.ok(rootStep)
  assert.deepEqual([rootStep.opts.agentType, rootStep.opts.model, rootStep.opts.phase], ['craft:engine-service', 'haiku', 'Start'])
  assert.match(rootStep.prompt, /craft_usable '\/opt\/craft-plugin'"\/\.claude-plugin\/plugin\.json"/, 'the manifest under the given root')
  assert.match(rootStep.prompt, /CRAFT_REPO="\$\(cd '\/work\/repo' /, 'checked against the reviewed repo')
  assert.equal(given.calls[1]?.prompt.split('\n\n')[1], "'/opt/craft' review start --cwd '/work/repo' --craft-root '/srv/craft-plugin'", 'start gets the resolved root')
  const refused = await runEngine('cli-review', {
    args: { repo: '/work/repo', craftBin: '/opt/craft', craftRoot: '/work/repo/craft' },
    script: { 'step:root': { exitCode: 1, stdout: '', stderr: 'inside the reviewed repo (/work/repo/craft/.claude-plugin/plugin.json in /work/repo)' } },
  })
  assert.match(refused.report, /^INCOMPLETE — cli-review: craftRoot="\/work\/repo\/craft" is not a usable plugin root: the command exited 1: inside the reviewed repo /)
  assert.deepEqual(refused.calls.map(c => c.label), ['step:root'], 'nothing runs past a refused root')
  const silent = await runEngine('cli-review', { args: { craftBin: '/opt/craft', craftRoot: '/opt/p' }, script: { 'step:root': ran('ok\n') } })
  assert.match(silent.report, /^INCOMPLETE — .*the check printed no absolute root= line: ok/)
  const bare = await runEngine('cli-review', { args: { craftBin: '/opt/craft' }, script: { 'step:start': done() } })
  assert.equal(bare.calls[0]?.prompt.split('\n\n')[1], "'/opt/craft' review start --cwd .")
})
