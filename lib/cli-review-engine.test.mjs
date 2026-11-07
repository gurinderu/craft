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
import profile from '../content/profiles/rust.json' with { type: 'json' }
import { PROFILES } from './review-profiles.mjs'

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
  assert.equal(lensCall.prompt, `Read the file ${RUN}/tasks/lens-intent.md and do exactly what it says: it is your whole task — run no gate, give no verdict and write no run record of your own beyond what it asks. When done, write your final answer as JSON matching the schema in ${RUN}/tasks/lens-intent.schema.json to ${RUN}/answers/lens-intent.json (create the directory if needed) and nothing else — without a Write tool, through Bash with a quoted heredoc: \`cat > '${RUN}/answers/lens-intent.json' <<'JSON'\` — then reply with the single word done.`)
  assert.deepEqual([lensCall.opts.model, lensCall.opts.schema, lensCall.opts.agentType], ['opus', undefined, undefined], 'the model the binary named, no schema, the default type')
  assert.equal(submit1.prompt.split('\n\n')[1], `'/opt/craft' review submit --run '${RUN}'`)
  assert.doesNotMatch(submit1.prompt, /findings|--answers/, 'no answer passes through the service agent')
  assert.equal(run.report, `Verdict: Block (run ${RUN})\n\nThe report is ${RUN}/report.md — read that file for the findings.`, 'the report is named by its path, never copied by a model')
  assert.deepEqual(run.phases, ['Start', 'Agents', 'Submit', 'Agents', 'Submit'])
  assert.ok(run.logs.some(l => l === 'round 1: 1 task(s) — lens:intent'), run.logs.join('\n'))
})

test('a multi-batch run: the scout, two lens rounds in parallel, the dedup and the verifiers, each step\'s batch run whole before its submit', async () => {
  const scout = task('scout-rust', 'scout:rust', 'haiku')
  const round = (/** @type {number} */ r) => ['errors', 'intent', 'tests'].map(l => task(`lens-${l}-r${r}`, `lens:rust:${l} r${r}`, 'opus'))
  const dedup = task('dedup-rust', 'dedup:rust', 'haiku')
  const verifyBatch = task('verify-batch-0', 'verify-batch:src/a.rs(2)', 'sonnet')
  /** @type {string[][]} */
  const answeredAtSubmit = []
  const written = () => ['scout-rust', ...round(1), ...round(2), dedup, verify(), verifyBatch].map(t => (typeof t === 'string' ? t : t.id)).filter(id => existsSync(`${RUN}/answers/${id}.json`))
  /** @param {object} next */
  const submitted = next => () => { answeredAtSubmit.push(written()); return next }
  const run = await runEngine('cli-review', {
    args: { repo: '/work/repo', craftBin: '/opt/craft' },
    script: {
      'step:start': pending([scout]),
      scout: writes({ sizeBucket: 'medium', lenses: ['errors'], isLibrary: false, securitySensitive: false, intent: '', churn: [], repoRules: [], notes: '' }),
      'step:submit:1': submitted(pending(round(1))),
      lens: writes(FINDINGS),
      'step:submit:2': submitted(pending(round(2))),
      'step:submit:3': submitted(pending([dedup])),
      dedup: writes({ groups: [] }),
      'step:submit:4': submitted(pending([verify(), verifyBatch])),
      verify: writes(VERDICT),
      'verify-batch': writes({ verdicts: [{ ...VERDICT, index: 0 }, { ...VERDICT, index: 1 }] }),
      'step:submit:5': submitted(done()),
    },
  })
  assert.deepEqual(run.calls.map(c => c.label), [
    'step:start', 'scout:rust', 'step:submit:1',
    'lens:rust:errors r1', 'lens:rust:intent r1', 'lens:rust:tests r1', 'step:submit:2',
    'lens:rust:errors r2', 'lens:rust:intent r2', 'lens:rust:tests r2', 'step:submit:3',
    'dedup:rust', 'step:submit:4',
    'verify:src/a.rs:3', 'verify-batch:src/a.rs(2)', 'step:submit:5',
  ])
  assert.deepEqual(answeredAtSubmit.map(a => a.length), [1, 4, 7, 8, 10], 'every task of a batch wrote its file before the submit that reads it')
  assert.deepEqual(run.calls.filter(c => c.label.startsWith('lens:')).map(c => c.opts.model), Array(6).fill('opus'), 'each task on the model the binary named')
  assert.deepEqual(run.phases, ['Start', 'Agents', 'Submit', 'Agents', 'Submit', 'Agents', 'Submit', 'Agents', 'Submit', 'Agents', 'Submit'])
  assert.ok(run.logs.includes('round 2: 3 task(s) — lens:rust:errors r1, lens:rust:intent r1, lens:rust:tests r1'), run.logs.join('\n'))
  assert.match(run.report, /^Verdict: Block/)
})

test('a dead agent writes no file; the retry the binary hands back runs again on the task\'s own agent type', async () => {
  const typed = { ...lens(), agentType: 'rust-reviewer' }
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
  const model = await runEngine('cli-review', { args: {}, script: { 'step:resolve': resolved(), 'step:start': pending([{ ...lens(), model: 'claude-opus' }]) } })
  assert.match(model.report, /^INCOMPLETE — .*no well-formed tasks/, 'a model token the driver cannot map is refused')
  assert.ok(!model.calls.some(c => c.label === 'lens:intent'), 'no agent runs on an unmapped model')
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
  assert.match(fetch.prompt, /CRAFT_ROOT_PATH="\$\(dirname "\$\(dirname "\$CRAFT_FETCHER"\)"\)"\n/, 'the root the fetcher was found in')
  assert.match(fetch.prompt, /printf 'root=%s\\nbin=%s\\n' "\$CRAFT_ROOT_PATH" "\$CRAFT_BIN_PATH"/, 'printed beside the binary')
  assert.match(fetch.prompt, /stdout is two lines, root=<the plugin root> and bin=<the binary's path>, the caller parses/)
  assert.equal(run.calls[1]?.prompt.split('\n\n')[1], `'${FETCHED}' review start --cwd '/work/repo' --craft-root '${PLUGIN}'`, 'start gets the root the step printed')
  assert.match(run.report, /^Verdict: Block/)
})

test('a fetch that fails or prints no absolute path ends the run INCOMPLETE before any step', async () => {
  const failed = await runEngine('cli-review', {
    args: {},
    script: { 'step:resolve': { exitCode: 1, stdout: '', stderr: 'craft-bin: no released craft binary for freebsd/x64' } },
  })
  assert.match(failed.report, /^INCOMPLETE — cli-review could not get the craft binary [\d.]+: the command exited 1: craft-bin: no released craft binary for freebsd\/x64\. Pass craftBin=/)
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

test('a Windows drive path is an absolute path: a given craft.exe, and the one a Windows fetch prints', async () => {
  const given = await runEngine('cli-review', { args: { craftBin: 'C:\\craft\\craft.exe' }, script: { 'step:start': done() } })
  assert.equal(given.calls[0]?.prompt.split('\n\n')[1], "'C:\\craft\\craft.exe' review start --cwd .")
  const exe = 'C:\\Users\\u\\.craft\\bin\\9.9.9\\craft.exe'
  const fetched = await runEngine('cli-review', { args: {}, script: { 'step:resolve': ran(`root=C:/plugin\nbin=${exe}\n`), 'step:start': done() } })
  assert.equal(fetched.calls[1]?.prompt.split('\n\n')[1], `'${exe}' review start --cwd . --craft-root 'C:/plugin'`)
  const relative = await runEngine('cli-review', { args: { craftBin: 'craft.exe' }, script: {} })
  assert.match(relative.report, /^INCOMPLETE — cli-review: craftBin="craft\.exe" is not an absolute path/)
})

test('a Windows fetch whose step printed Git Bash\'s /c/… root hands the binary C:/…; a POSIX one keeps its root', async () => {
  const exe = 'C:\\Users\\u\\.craft\\bin\\9.9.9\\craft.exe'
  const win = await runEngine('cli-review', { args: {}, script: { 'step:resolve': ran(`root=/c/Users/u/plugin\nbin=${exe}\n`), 'step:start': done() } })
  assert.match(win.calls[0]?.prompt ?? '', /cygpath -m/)
  assert.equal(win.calls[1]?.prompt.split('\n\n')[1], `'${exe}' review start --cwd . --craft-root 'C:/Users/u/plugin'`)
  const posix = await runEngine('cli-review', { args: {}, script: { 'step:resolve': ran('root=/c/plugin\nbin=/c/bin/craft\n'), 'step:start': done() } })
  assert.equal(posix.calls[1]?.prompt.split('\n\n')[1], "'/c/bin/craft' review start --cwd . --craft-root '/c/plugin'")
})

test('the profile\'s lens agent, named without a prefix, launches as the plugin agent the engine\'s Rust lenses run on', async () => {
  const typed = { ...lens(), agentType: profile.lensAgent }
  const run = await runEngine('cli-review', {
    args: { craftBin: '/opt/craft' },
    script: { 'step:start': pending([typed, verify()]), lens: writes(FINDINGS), verify: writes(VERDICT), 'step:submit:1': done() },
  })
  const byLabel = Object.fromEntries(run.calls.map(c => [c.label, c.opts.agentType]))
  assert.equal(byLabel['lens:intent'], PROFILES['rust']?.reviewerAgent, 'the CLI lens runs on the agent review.js runs its Rust lenses on')
  assert.equal(byLabel['lens:intent'], 'craft:rust-reviewer')
  assert.equal(byLabel['verify:src/a.rs:3'], undefined, 'a task naming no agent runs on the default type')
  assert.match(run.report, /^Verdict: Block/)
})

test('an agent the session has not registered: its tasks run on the default type, learned once from the first throw', async () => {
  const typed = (/** @type {string} */ id) => ({ ...task(id, `lens:${id}`, 'opus'), agentType: 'rust-reviewer' })
  const run = await runEngine('cli-review', {
    args: { craftBin: '/opt/craft' },
    script: {
      'step:start': pending([typed('a')]),
      'lens:a': (/** @type {{ opts: { agentType?: string }, prompt: string }} */ c) => {
        if (c.opts.agentType) throw new Error("Agent type 'craft:rust-reviewer' not found. Available agents: general-purpose")
        return writes(FINDINGS)(c)
      },
      'step:submit:1': pending([typed('b')]),
      'lens:b': writes(FINDINGS),
      'step:submit:2': done(),
    },
  })
  assert.deepEqual(run.calls.filter(c => c.label.startsWith('lens:')).map(c => [c.label, c.opts.agentType]),
    [['lens:a', 'craft:rust-reviewer'], ['lens:a', undefined], ['lens:b', undefined]])
  assert.equal(run.logs.filter(l => /'craft:rust-reviewer' is not registered here/.test(l)).length, 1, run.logs.join('\n'))
  assert.ok(existsSync(`${RUN}/answers/a.json`) && existsSync(`${RUN}/answers/b.json`))
})

test('an agent name this plugin does not ship runs on the default type, said once', async () => {
  const odd = (/** @type {string} */ id) => ({ ...task(id, `lens:${id}`, 'opus'), agentType: 'no-such-agent' })
  const run = await runEngine('cli-review', {
    args: { craftBin: '/opt/craft' },
    script: { 'step:start': pending([odd('a'), odd('b')]), 'lens:a': writes(FINDINGS), 'lens:b': writes(FINDINGS), 'step:submit:1': done() },
  })
  assert.deepEqual(run.calls.filter(c => c.label.startsWith('lens:')).map(c => c.opts.agentType), [undefined, undefined])
  assert.equal(run.logs.filter(l => l.includes("task agent 'no-such-agent' is not one this plugin ships")).length, 1, run.logs.join('\n'))
})
