// The review engine (src/review.js, lib/cli-review-steps.mjs) driven end to end with scripted agents: the
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
import { verdictLine } from './rust-audit-verdict.mjs'

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
const done = () => ran({ run: RUN, done: true, report: `${RUN}/report.md`, verdict: 'Block', filing: { runDir: '', rejoin: false, lost: [], record: 'filed' } })
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
/** The labels of the calls that run the review, the record's bookkeeping left out. @param {{ calls: { label: string }[] }} run */
const work = run => run.calls.map(c => c.label).filter(l => !/^(checkpoint|log-run)/.test(l))
/** The verdict line of a run's answer, as every reader of a review report parses it. @param {{ report: string }} run */
const verdictOf = run => verdictLine(run.report) ?? ''

/** The answer file of task `id` as the binary would read it. @param {string} id @returns {unknown} */
const answerOf = id => JSON.parse(readFileSync(`${RUN}/answers/${id}.json`, 'utf8'))
/** The start's last flag: the binary files the run's telemetry itself, under the engine's version. */
const RECORD = ` --record '${JSON.parse(readFileSync(new URL('../integrations/claude-code/.claude-plugin/plugin.json', import.meta.url), 'utf8')).version}'`

test('one full loop: start, the lens, its findings verified, done, the report by its path — all through files', async () => {
  /** @type {unknown[]} */
  const seen = []
  const run = await runEngine('review', {
    args: { repo: '/work/repo', base: 'origin/main', craftBin: '/opt/craft' },
    script: {
      'step:locate': ran(`root=${PLUGIN}\n`),
      'step:start': pending([lens()]),
      lens: writes(FINDINGS),
      'step:submit:1': () => { seen.push(answerOf('lens-intent')); return pending([verify()]) },
      verify: writes(VERDICT),
      'step:submit:2': () => { seen.push(answerOf('verify-0')); return done() },
    },
  })
  assert.deepEqual(run.calls.map(c => c.label), ['step:locate', 'step:start', 'lens:intent', 'step:submit:1', 'verify:src/a.rs:3', 'step:submit:2'], 'no checkpoint or record agent: the binary files its own telemetry')
  assert.deepEqual(seen, [FINDINGS, VERDICT], 'each answer reached the binary as the file its agent wrote')
  const [, start, lensCall, submit1] = run.calls.filter(c => work({ calls: [c] }).length).map(c => ({ prompt: c.prompt, opts: c.opts }))
  assert.ok(start && lensCall && submit1)
  assert.match(start.prompt, /^Run exactly this one command, in one Bash call with a timeout of 600000 ms \(it may fetch the source of each integration point the reviewer's profile names, and may build and lint the branch for the mechanical gate\):\n\n'\/opt\/craft' review start --cwd '\/work\/repo' --base 'origin\/main' --record-root '\/home\/u\/\.claude\/plugins\/cache\/craft\/craft\/0\.40\.1' --record '[^']+'$/m)
  assert.equal(start.opts.agentType, 'craft:engine-service')
  assert.equal(lensCall.prompt, `Read the file ${RUN}/tasks/lens-intent.md and do exactly what it says: it is your whole task — run no gate, give no verdict and write no run record of your own beyond what it asks. When done, write your final answer as JSON matching the schema in ${RUN}/tasks/lens-intent.schema.json to ${RUN}/answers/lens-intent.json (create the directory if needed) and nothing else — without a Write tool, through Bash with a quoted heredoc: \`cat > '${RUN}/answers/lens-intent.json' <<'JSON'\` — then reply with the single word done.`)
  assert.deepEqual([lensCall.opts.model, lensCall.opts.schema, lensCall.opts.agentType], ['opus', undefined, undefined], 'the model the binary named, no schema, the default type')
  assert.match(submit1.prompt.split('\n\n')[1] ?? '', new RegExp(`^'/opt/craft' review submit --run '${RUN}' --agents 1 --output-tokens \\d+$`), 'the task agents dispatched and the tokens spent, for the binary\'s telemetry')
  assert.doesNotMatch(submit1.prompt, /findings|--answers/, 'no answer passes through the service agent')
  assert.equal(run.report, `## Verdict\n\n⛔ Block\n\nThe report is ${RUN}/report.md — read that file for the findings (run ${RUN}).\n\n## Findings\n\nNone reported.`, 'the report is named by its path, never copied by a model')
  assert.equal(verdictOf(run), '⛔ Block')
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
  const run = await runEngine('review', {
    args: { repo: '/work/repo', craftBin: '/opt/craft' },
    script: {
      'step:locate': ran(`root=${PLUGIN}\n`),
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
  assert.deepEqual(work(run), [
    'step:locate', 'step:start', 'scout:rust', 'step:submit:1',
    'lens:rust:errors r1', 'lens:rust:intent r1', 'lens:rust:tests r1', 'step:submit:2',
    'lens:rust:errors r2', 'lens:rust:intent r2', 'lens:rust:tests r2', 'step:submit:3',
    'dedup:rust', 'step:submit:4',
    'verify:src/a.rs:3', 'verify-batch:src/a.rs(2)', 'step:submit:5',
  ])
  assert.deepEqual(answeredAtSubmit.map(a => a.length), [1, 4, 7, 8, 10], 'every task of a batch wrote its file before the submit that reads it')
  assert.deepEqual(run.calls.filter(c => c.label.startsWith('lens:')).map(c => c.opts.model), Array(6).fill('opus'), 'each task on the model the binary named')
  assert.deepEqual(run.phases, ['Start', 'Agents', 'Submit', 'Agents', 'Submit', 'Agents', 'Submit', 'Agents', 'Submit', 'Agents', 'Submit'])
  assert.ok(run.logs.includes('round 2: 3 task(s) — lens:rust:errors r1, lens:rust:intent r1, lens:rust:tests r1'), run.logs.join('\n'))
  assert.equal(verdictOf(run), '⛔ Block')
})

test('a dead agent on the default type writes no file; the retry the binary hands back runs it again', async () => {
  const untyped = lens()
  /** @type {boolean[]} */
  const fileAtSubmit = []
  const run = await runEngine('review', {
    args: {},
    script: {
      'step:resolve': resolved(),
      'step:start': pending([untyped]),
      lens: (/** @type {{ callIndex: number, prompt: string }} */ c) => (c.callIndex === 0 ? null : writes(FINDINGS)(c)),
      'step:submit:1': () => { fileAtSubmit.push(existsSync(untyped.answerFile)); return pending([untyped]) },
      'step:submit:2': () => { fileAtSubmit.push(existsSync(untyped.answerFile)); return done() },
    },
  })
  assert.deepEqual(fileAtSubmit, [false, true])
  const lensCalls = run.calls.filter(c => c.label === 'lens:intent')
  assert.deepEqual(lensCalls.map(c => c.opts.agentType), [undefined, undefined], 'a null from an untyped task is a dead agent, not a fallback')
  assert.ok(run.calls.every(c => !/--degraded/.test(c.prompt)), 'and no degraded note')
  assert.equal(run.calls[0]?.label, 'step:resolve')
  assert.match(run.calls[1]?.prompt ?? '', /^'\/home\/u\/\.craft\/bin\/0\.40\.1\/craft' review start --cwd \. --craft-root '\/home\/u\/\.claude\/plugins\/cache\/craft\/craft\/0\.40\.1' --record '[^']+'$/m, 'the fetched path runs every step, told the plugin root it cannot find above itself')
  assert.equal(verdictOf(run), '⛔ Block')
})

test('a step that cannot be read ends the run INCOMPLETE, never as a verdict', async () => {
  const failed = await runEngine('review', {
    args: {},
    script: { 'step:resolve': resolved(), 'step:start': { exitCode: 1, stdout: '', stderr: 'craft: the base nope is not a commit' } },
  })
  assert.match(failed.report, /^## Verdict\n\n⚠️ INCOMPLETE — review stopped at round 1: the command exited 1: craft: the base nope is not a commit/)
  const garbled = await runEngine('review', { args: {}, script: { 'step:resolve': resolved(), 'step:start': ran('{"run": "/tmp/x", "tasks": [') } })
  assert.match(verdictOf(garbled), /^⚠️ INCOMPLETE — .*printed no JSON/)
  const relative = await runEngine('review', { args: {}, script: { 'step:resolve': resolved(), 'step:start': pending([{ ...lens(), answerFile: 'answers/x.json' }]) } })
  assert.match(verdictOf(relative), /^⚠️ INCOMPLETE — .*no well-formed tasks/, 'a task file that is not an absolute path is refused')
  const model = await runEngine('review', { args: {}, script: { 'step:resolve': resolved(), 'step:start': pending([{ ...lens(), model: 'claude-opus' }]) } })
  assert.match(verdictOf(model), /^⚠️ INCOMPLETE — .*no well-formed tasks/, 'a model token the driver cannot map is refused')
  assert.ok(!model.calls.some(c => c.label === 'lens:intent'), 'no agent runs on an unmapped model')
  const refused = await runEngine('review', { args: { craftBin: 'craft' }, script: { 'log-run': { ok: true, output: ['wrote /store/r.json'] } } })
  assert.match(verdictOf(refused), /^⚠️ INCOMPLETE — review: craftBin="craft" is not an absolute path\. Nothing ran\./)
  assert.deepEqual(refused.calls.map(c => c.label), ['log-run'], 'a refused argument files only its refusal: nothing ran')
  const depth = await runEngine('review', { args: { craftBin: '/opt/craft', depth: 'deep' }, script: { 'log-run': { ok: true, output: ['wrote /store/r.json'] } } })
  assert.match(verdictOf(depth), /^⚠️ INCOMPLETE — review: depth="deep" is not light or full\. Nothing ran\./)
})

test('a spent budget fails the run closed rather than reporting a verdict', async () => {
  const script = { 'step:resolve': resolved(), 'step:start': pending([lens()]), lens: writes(FINDINGS), 'step:submit:1': done() }
  await assert.rejects(runEngine('review', { args: {}, script, budgetTotal: CALL_SPEND * 2 }), /budget exhausted/)
})

test('without craftBin the released binary of this version is fetched first, the fetcher located like the logger', async () => {
  const run = await runEngine('review', {
    args: { repo: '/work/repo', craftRoot: '/opt/craft-plugin' },
    script: { 'step:resolve': resolved(), 'step:start': done() },
  })
  assert.deepEqual(work(run), ['step:resolve', 'step:start'])
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
  assert.equal(run.calls[1]?.prompt.split('\n\n')[1], `'${FETCHED}' review start --cwd '/work/repo' --craft-root '${PLUGIN}'${RECORD}`, 'start gets the root the step printed')
  assert.equal(verdictOf(run), '⛔ Block')
})

test('a fetch that fails or prints no absolute path ends the run INCOMPLETE before any step', async () => {
  const failed = await runEngine('review', {
    args: {},
    script: { 'step:resolve': { exitCode: 1, stdout: '', stderr: 'craft-bin: no released craft binary for freebsd/x64' } },
  })
  assert.match(verdictOf(failed), /^⚠️ INCOMPLETE — review could not get the craft binary [\d.]+: the command exited 1: craft-bin: no released craft binary for freebsd\/x64\. Pass craftBin=/)
  assert.deepEqual(work(failed), ['step:resolve'])
  const relative = await runEngine('review', { args: {}, script: { 'step:resolve': ran(`root=${PLUGIN}\nbin=craft\n`) } })
  assert.match(verdictOf(relative), /^⚠️ INCOMPLETE — .*the fetch printed no absolute root= and bin= lines: root=/)
  assert.deepEqual(work(relative), ['step:resolve'])
  const rootless = await runEngine('review', { args: {}, script: { 'step:resolve': ran(`${FETCHED}\n`) } })
  assert.match(verdictOf(rootless), /^⚠️ INCOMPLETE — .*no absolute root= and bin= lines/, 'a binary path without the root is not enough')
})

test('with craftBin, start gets --craft-root when craftRoot is given and checked, else --record-root: the plugin root located like the logger, for filing only', async () => {
  const given = await runEngine('review', {
    args: { repo: '/work/repo', craftBin: '/opt/craft', craftRoot: '/opt/craft-plugin' },
    script: { 'step:root': ran('root=/srv/craft-plugin\n'), 'step:start': done() },
  })
  assert.deepEqual(work(given), ['step:root', 'step:start'], 'no fetch when craftBin is given, only the root checked')
  const rootStep = given.calls[0]
  assert.ok(rootStep)
  assert.deepEqual([rootStep.opts.agentType, rootStep.opts.model, rootStep.opts.phase], ['craft:engine-service', 'haiku', 'Start'])
  assert.match(rootStep.prompt, /craft_usable '\/opt\/craft-plugin'"\/\.claude-plugin\/plugin\.json"/, 'the manifest under the given root')
  assert.match(rootStep.prompt, /CRAFT_REPO="\$\(cd '\/work\/repo' /, 'checked against the reviewed repo')
  assert.equal(given.calls[1]?.prompt.split('\n\n')[1], `'/opt/craft' review start --cwd '/work/repo' --craft-root '/srv/craft-plugin'${RECORD}`, 'start gets the resolved root')
  const refused = await runEngine('review', {
    args: { repo: '/work/repo', craftBin: '/opt/craft', craftRoot: '/work/repo/craft' },
    script: { 'step:root': { exitCode: 1, stdout: '', stderr: 'inside the reviewed repo (/work/repo/craft/.claude-plugin/plugin.json in /work/repo)' } },
  })
  assert.match(verdictOf(refused), /^⚠️ INCOMPLETE — review: craftRoot="\/work\/repo\/craft" is not a usable plugin root: the command exited 1: inside the reviewed repo /)
  assert.deepEqual(work(refused), ['step:root'], 'nothing runs past a refused root')
  const silent = await runEngine('review', { args: { craftBin: '/opt/craft', craftRoot: '/opt/p' }, script: { 'step:root': ran('ok\n') } })
  assert.match(verdictOf(silent), /^⚠️ INCOMPLETE — .*the check printed no absolute root= line: ok/)
  const located = await runEngine('review', {
    args: { repo: '/work/repo', craftBin: '/opt/craft' },
    script: { 'step:locate': ran(`root=${PLUGIN}\n`), 'step:start': done() },
  })
  assert.deepEqual(work(located), ['step:locate', 'step:start'], 'no fetch, the plugin root located')
  const locate = located.calls[0]
  assert.ok(locate)
  assert.deepEqual([locate.opts.agentType, locate.opts.model, locate.opts.phase], ['craft:engine-service', 'haiku', 'Start'])
  assert.doesNotMatch(locate.prompt, /CRAFT_TRY='/, 'no craftRoot to try')
  assert.match(locate.prompt, /\$\{CLAUDE_PLUGIN_ROOT:-\}\/lib\/cli-review-file\.mjs/, 'the plugin root first')
  assert.match(locate.prompt, /plugins\/cache\/craft\/craft\/"'\d+\.\d+\.\d+'"\/lib\/cli-review-file\.mjs/, 'then this version\'s installed copy')
  assert.match(locate.prompt, /CRAFT_REPO="\$\(cd '\/work\/repo' /, 'never inside the reviewed repo')
  assert.match(locate.prompt, /CRAFT_ROOT_PATH="\$\(dirname "\$\(dirname "\$CRAFT_ADAPTER"\)"\)"\n/, 'the root the run-record writer was found in')
  assert.equal(located.calls[1]?.prompt.split('\n\n')[1], `'/opt/craft' review start --cwd '/work/repo' --record-root '${PLUGIN}'${RECORD}`, 'start files through the located root; its prompts keep the binary\'s own')
  const lost = await runEngine('review', { args: { craftBin: '/opt/craft' }, script: { 'step:locate': { exitCode: 1, stdout: '', stderr: 'no usable lib/cli-review-file.mjs — CLAUDE_PLUGIN_ROOT: unset; ' }, 'step:start': done() } })
  assert.equal(lost.calls.at(-1)?.prompt.split('\n\n')[1], `'/opt/craft' review start --cwd .${RECORD}`, 'none located: the binary looks for one itself')
  assert.ok(lost.logs.some(l => /no craft plugin root was located for the run's telemetry: the command exited 1: no usable lib\/cli-review-file\.mjs/.test(l)), lost.logs.join('\n'))
  assert.equal(verdictOf(lost), '⛔ Block')
})

test('a Windows drive path is an absolute path: a given craft.exe, and the one a Windows fetch prints', async () => {
  const given = await runEngine('review', { args: { craftBin: 'C:\\craft\\craft.exe' }, script: { 'step:locate': ran('root=C:/plugin\n'), 'step:start': done() } })
  assert.equal(given.calls[1]?.prompt.split('\n\n')[1], `'C:\\craft\\craft.exe' review start --cwd . --record-root 'C:/plugin'${RECORD}`)
  const exe = 'C:\\Users\\u\\.craft\\bin\\9.9.9\\craft.exe'
  const fetched = await runEngine('review', { args: {}, script: { 'step:resolve': ran(`root=C:/plugin\nbin=${exe}\n`), 'step:start': done() } })
  assert.equal(fetched.calls[1]?.prompt.split('\n\n')[1], `'${exe}' review start --cwd . --craft-root 'C:/plugin'${RECORD}`)
  const relative = await runEngine('review', { args: { craftBin: 'craft.exe' }, script: { 'log-run': { ok: true, output: ['wrote /store/r.json'] } } })
  assert.match(verdictOf(relative), /^⚠️ INCOMPLETE — review: craftBin="craft\.exe" is not an absolute path/)
})

test('a Windows fetch whose step printed Git Bash\'s /c/… root hands the binary C:/…; a POSIX one keeps its root', async () => {
  const exe = 'C:\\Users\\u\\.craft\\bin\\9.9.9\\craft.exe'
  const win = await runEngine('review', { args: {}, script: { 'step:resolve': ran(`root=/c/Users/u/plugin\nbin=${exe}\n`), 'step:start': done() } })
  assert.match(win.calls[0]?.prompt ?? '', /cygpath -m/)
  assert.equal(win.calls[1]?.prompt.split('\n\n')[1], `'${exe}' review start --cwd . --craft-root 'C:/Users/u/plugin'${RECORD}`)
  const posix = await runEngine('review', { args: {}, script: { 'step:resolve': ran('root=/c/plugin\nbin=/c/bin/craft\n'), 'step:start': done() } })
  assert.equal(posix.calls[1]?.prompt.split('\n\n')[1], `'/c/bin/craft' review start --cwd . --craft-root '/c/plugin'${RECORD}`)
})
