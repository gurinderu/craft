// The Claude Code driver of the CLI's step protocol (src/cli-review.js; realm @nick/craft, node #453): the `craft`
// binary decides what a review needs and starts no agent, this driver runs the agents each step hands out and
// hands their answers back. It holds no review logic: what to ask, of which model, in which shape, and what the
// answers mean are all the binary's. The sandbox reads no file and spawns no process (#134), so a service agent runs
// the binary and returns its small JSON verbatim; the prompts, schemas and answers themselves travel as files in the
// run directory — each task's agent reads its prompt file and writes its answer file — so no model copies them.
// It files the run's record as the other engines do (lib/cli-review-record.mjs), and locates the plugin's
// lib/craft-bin.mjs the way every plugin script an agent runs is located (plugin-script.mjs).
import { pluginRootCheck, pluginScriptPrelude, shq } from './plugin-script.mjs'
import { SERVICE_AGENT_TYPE, makeDefaultTypeFallback } from './service-agent.mjs'
import { isTaskModel, taskRunner } from './cli-review-task.mjs'
import { cliRecorder } from './cli-review-record.mjs'
import { finishedAnswer, stoppedAnswer } from './cli-review-verdict.mjs'
import { normalizeArgs } from './workflow-args.mjs'

/** @typedef {{ id: string, label: string, model: string, promptFile: string, schemaFile: string, answerFile: string, agentType?: string }} Task */
/** @typedef {import('./cli-review-record.mjs').Finding} Finding */
/** @typedef {import('./cli-review-record.mjs').LedgerRow} LedgerRow */
/** @typedef {{ run: string, done: true, report: string, verdict: string, line: string, degraded: boolean, head: string, base: string, findings: Finding[], uncovered: string[], notRun: string[], round: number, lensScope: 'delta' | 'full', ledger: LedgerRow[] | null, reReview: Record<string, unknown> | null }} Finished  ledger null when the binary sent none */
/** @typedef {{ run: string, done: false, tasks: Task[], head: string } | Finished} Step */
/** @typedef {{ repo: string, base: string, depth: string, craftBin: string | null, craftRoot: string, fresh: boolean, fullEvery: string }} Options  craftBin shell-quoted, null until fetched; depth and fullEvery '' when not given */
/** @typedef {(prompt: string, opts?: Record<string, unknown>) => Promise<unknown>} Agent */
/** @typedef {{ args: unknown, agent: Agent, parallel: <T>(thunks: Array<() => Promise<T>>) => Promise<Array<T | null>>, phase: (title: string) => void, log: (message: string) => void, budget?: { spent: () => number } }} Sandbox */

// The scout, up to three lens rounds, the dedup and verification in up to two waves (a split deciding pair buys the
// rest of its panel) — seven steps, each asked at most three times (the binary's two retries): twenty-one rounds;
// three spare. Only a backstop: the binary decides when the run is done.
const MAX_ROUNDS = 24
// The fetcher of the released binary, inside the plugin.
const FETCHER = 'lib/craft-bin.mjs'
// The depths `craft review start --depth` takes.
const DEPTHS = new Set(['light', 'full'])

/** What a service step returns: the command's exit status and its output, copied whole. */
const RUN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['exitCode', 'stdout', 'stderr'],
  properties: { exitCode: { type: 'integer' }, stdout: { type: 'string' }, stderr: { type: 'string' } },
}

/** Whether `s` holds a control character. @param {string} s */
const hasControl = s => [...s].some(c => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)
/**
 * An absolute path an agent can quote into a command, else null: POSIX, or a Windows drive path (`C:\…\craft.exe`,
 * as craft-bin prints it there), which the harness's Git Bash runs single-quoted as it stands.
 * @param {unknown} v @returns {string | null}
 */
const absolutePath = v => (typeof v === 'string' && (v.startsWith('/') || /^[A-Za-z]:[\\/]/.test(v)) && !hasControl(v) ? v : null)

/** Why `a` names an option path that is not absolute, '' when none does. @param {Record<string, unknown>} a @returns {string} */
function badPath(a) {
  const bad = ['repo', 'craftBin', 'craftRoot'].find(k => a[k] != null && absolutePath(a[k]) === null)
  return bad ? `${bad}=${JSON.stringify(a[bad])} is not an absolute path` : ''
}

/** The base ref, '' when absent, null when it is no ref name. @param {unknown} v @returns {string | null} */
function refName(v) {
  if (v == null || v === '') return ''
  return typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/@^~-]{0,199}$/.test(v) ? v : null
}

/**
 * The round chain's arguments the binary takes: `fresh` (a new chain) and `fullEvery` (a whole-diff round every N),
 * or why they cannot be used. The binary decides which earlier round to build on and what to review.
 * @param {Record<string, unknown>} a @returns {{ fresh: boolean, fullEvery: string } | { refused: string }}
 */
function roundOptions(a) {
  const fresh = a['fresh'] ?? false
  if (fresh !== true && fresh !== false) return { refused: `fresh=${JSON.stringify(fresh)} is not true or false` }
  const every = a['fullEvery']
  if (every == null) return { fresh, fullEvery: '' }
  return Number.isInteger(every) && Number(every) >= 0 ? { fresh, fullEvery: String(every) } : { refused: `fullEvery=${JSON.stringify(every)} is not a whole number of rounds` }
}

/**
 * The run's options from `args`, or why they cannot be used.
 * @param {Record<string, unknown>} a @returns {{ options: Options } | { refused: string }}
 */
function readOptions(a) {
  const refused = badPath(a)
  if (refused) return { refused }
  const base = refName(a['base'])
  if (base === null) return { refused: `base=${JSON.stringify(a['base'])} is not a ref name` }
  const depth = a['depth'] ?? ''
  if (depth !== '' && !DEPTHS.has(String(depth))) return { refused: `depth=${JSON.stringify(depth)} is not light or full` }
  const chain = roundOptions(a)
  if ('refused' in chain) return chain
  const bin = absolutePath(a['craftBin'])
  return { options: { repo: absolutePath(a['repo']) ?? '', base, depth: String(depth), craftBin: bin ? shq(bin) : null, craftRoot: absolutePath(a['craftRoot']) ?? '', ...chain } }
}

/**
 * The service step's instructions around `steps`.
 * @param {string} steps @param {string} [stdout]  what its stdout is @returns {string}
 */
const servicePrompt = (steps, stdout = 'one JSON value') => `${steps}

Return {exitCode, stdout, stderr}: the last command's exit status, and its stdout and stderr each copied VERBATIM and WHOLE. stdout is ${stdout} the caller parses: never summarize, reformat, pretty-print or shorten it. Run nothing else.`

/**
 * The step that gets the binary of this plugin version: lib/craft-bin.mjs, located like the logger (craftRoot,
 * then CLAUDE_PLUGIN_ROOT, then this version's installed copy), fetches it; the step prints the plugin root it found
 * the fetcher in and the binary's path, so the binary — which, fetched under ~/.craft/bin, finds no plugin root above
 * itself — is handed the root its prompts name.
 * @param {Options} o @param {string} version @returns {string}
 */
function resolvePrompt(o, version) {
  const locate = pluginScriptPrelude(o.craftRoot || undefined, version, o.repo, FETCHER, 'CRAFT_FETCHER')
  return servicePrompt(`Run this ONCE, exactly as written, in one Bash call:

\`\`\`sh
${locate}if [ -z "\${CRAFT_FETCHER:-}" ]; then printf '%s\\n' "no usable ${FETCHER} — \${CRAFT_FETCHER_WHY}" >&2; exit 1; fi
CRAFT_BIN_PATH="$(node "$CRAFT_FETCHER" ensure --version ${shq(version)})" || exit $?
CRAFT_ROOT_PATH="$(dirname "$(dirname "$CRAFT_FETCHER")")"
if command -v cygpath >/dev/null 2>&1; then CRAFT_ROOT_PATH="$(cygpath -m "$CRAFT_ROOT_PATH")"; fi
printf 'root=%s\\nbin=%s\\n' "$CRAFT_ROOT_PATH" "$CRAFT_BIN_PATH"
\`\`\``, 'two lines, root=<the plugin root> and bin=<the binary\'s path>,')
}

/**
 * The plugin root and the binary's path (shell-quoted) the step printed, or why they are not there.
 * @param {unknown} got @returns {{ bin: string, root: string } | { error: string }}
 */
function resolvedBin(got) {
  const out = commandOutput(got)
  if ('error' in out) return out
  const bin = printedPath(out.stdout, 'bin')
  const root = printedPath(out.stdout, 'root')
  return bin && root ? { bin: shq(bin), root: driveRoot(root, bin) } : { error: `the fetch printed no absolute root= and bin= lines: ${out.stdout.slice(0, 200)}` }
}

/**
 * The root as the Windows binary reads it: beside a drive-path binary, Git Bash's `/c/…` (a step without cygpath, which
 * would have printed `C:/…`) becomes `C:/…`; any other root is left as it stands.
 * @param {string} root @param {string} bin @returns {string}
 */
const driveRoot = (root, bin) => {
  const m = /^[A-Za-z]:[\\/]/.test(bin) ? /^\/([A-Za-z])(\/.*)?$/.exec(root) : null
  return m?.[1] ? `${m[1].toUpperCase()}:${m[2] ?? '/'}` : root
}

/** The absolute path on the `<key>=` line of `stdout`, else null. @param {string} stdout @param {string} key */
const printedPath = (stdout, key) => absolutePath(stdout.split('\n').map(l => l.trim()).find(l => l.startsWith(`${key}=`))?.slice(key.length + 1))

/**
 * The step that checks a craftRoot given beside craftBin, which no fetch locates: by the rule every plugin script is
 * located by (plugin-script.mjs), it must hold the plugin manifest outside the reviewed repo.
 * @param {Options} o @returns {string}
 */
const rootPrompt = o => servicePrompt(`Run this ONCE, exactly as written, in one Bash call:

\`\`\`sh
${pluginRootCheck(o.craftRoot, o.repo)}\`\`\``, 'one line, root=<the plugin root>,')

/** The checked root, or why it is not one. @param {unknown} got @returns {{ root: string } | { error: string }} */
function checkedRoot(got) {
  const out = commandOutput(got)
  if ('error' in out) return out
  const root = printedPath(out.stdout, 'root')
  return root ? { root } : { error: `the check printed no absolute root= line: ${out.stdout.slice(0, 200)}` }
}

/**
 * The binary stores the root in the run's state, so submit renders its retries and verifiers with the same one.
 * @param {Options} o @param {string} bin @param {string} root  the plugin root its prompts name, '' to let it look above itself
 * @returns {string}
 */
function startPrompt(o, bin, root) {
  const chain = `${o.fresh ? ' --fresh' : ''}${o.fullEvery ? ` --full-every ${o.fullEvery}` : ''}`
  const cmd = `${bin} review start --cwd ${o.repo ? shq(o.repo) : '.'}${o.base ? ` --base ${shq(o.base)}` : ''}${o.depth ? ` --depth ${o.depth}` : ''}${chain}${root ? ` --craft-root ${shq(root)}` : ''}`
  return servicePrompt(`Run exactly this one command:\n\n${cmd}`)
}

/**
 * The submit, with a `--degraded` note for each way the step's tasks ran weaker than asked, kept for the report.
 * @param {string} bin @param {string} run @param {string[]} degraded @returns {string}
 */
const submitPrompt = (bin, run, degraded) => servicePrompt(`Run exactly this one command:\n\n${bin} review submit --run ${shq(run)}${degraded.map(n => ` --degraded ${shq(n)}`).join('')}`)

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)

/** @param {unknown} t @returns {t is Task} */
function isTask(t) {
  if (!isObject(t)) return false
  const s = /** @param {string} k */ k => typeof t[k] === 'string'
  const file = /** @param {string} k */ k => absolutePath(t[k]) !== null
  return s('id') && s('label') && isTaskModel(t['model']) && file('promptFile') && file('schemaFile') && file('answerFile') && (t['agentType'] === undefined || s('agentType'))
}

/**
 * The command's output from a service answer, or why there is none.
 * @param {unknown} got @returns {{ stdout: string } | { error: string }}
 */
function commandOutput(got) {
  if (!isObject(got) || typeof got['stdout'] !== 'string') return { error: 'the service agent returned no command output' }
  if (got['exitCode'] !== 0) return { error: `the command exited ${String(got['exitCode'])}: ${String(got['stderr'] ?? '').trim().slice(0, 400)}` }
  return { stdout: got['stdout'] }
}

/**
 * The step the binary printed, or why it cannot be read.
 * @param {unknown} got @returns {{ step: Step } | { error: string }}
 */
function readStep(got) {
  const out = commandOutput(got)
  if ('error' in out) return out
  /** @type {unknown} */
  let v
  try { v = JSON.parse(out.stdout) } catch { return { error: `the command printed no JSON: ${out.stdout.slice(0, 200)}` } }
  if (!isObject(v) || absolutePath(v['run']) === null) return { error: 'the step names no run directory' }
  return v['done'] === true ? finishedStep(v) : pendingStep(v)
}

/** @param {unknown} v @returns {string} */
const stepText = v => (typeof v === 'string' ? v : '')
/** @param {unknown} v @returns {string[]} */
const strings = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : [])

/** A finished step's reported findings, as its run record keeps them. @param {unknown} v @returns {Finding[]} */
const findingsOf = v => (Array.isArray(v) ? v.filter(isObject) : []).map(f => ({
  severity: String(f['severity'] ?? ''), file: String(f['file'] ?? ''), line: Number.isInteger(f['line']) ? Number(f['line']) : 0,
  title: String(f['title'] ?? ''), ruleId: String(f['ruleId'] ?? ''), tier: String(f['tier'] ?? ''),
}))

/** @param {Record<string, unknown>} v  a step with a run directory @returns {{ step: Step } | { error: string }} */
function finishedStep(v) {
  const report = absolutePath(v['report'])
  const verdict = v['verdict']
  if (report === null || typeof verdict !== 'string') return { error: 'a finished step names no report or verdict' }
  return {
    step: {
      run: /** @type {string} */ (v['run']), done: true, report, verdict, line: stepText(v['line']),
      degraded: strings(v['degraded']).length > 0, head: stepText(v['head']), base: stepText(v['base']),
      findings: findingsOf(v['findings']), uncovered: strings(v['uncovered']), notRun: strings(v['notRun']),
      ...roundOf(v),
    },
  }
}

/**
 * What the next round of the branch needs from a finished step: its round, its ledger, how it built on the last.
 * A round that reviewed only the fix commits is `delta`, so no reader takes it for coverage of the whole diff at its head.
 * @param {Record<string, unknown>} v @returns {{ round: number, lensScope: 'delta' | 'full', ledger: LedgerRow[] | null, reReview: Record<string, unknown> | null }}
 */
const roundOf = v => ({
  round: Number.isInteger(v['round']) && Number(v['round']) > 0 ? Number(v['round']) : 1,
  lensScope: v['lensScope'] === 'delta' ? 'delta' : 'full',
  ledger: Array.isArray(v['ledger']) ? v['ledger'].filter(isObject).map(ledgerRowOf) : null,
  reReview: isObject(v['reReview']) ? v['reReview'] : null,
})

/** One row of the binary's ledger, its fields as strings and its line a number. @param {Record<string, unknown>} r @returns {LedgerRow} */
const ledgerRowOf = r => ({
  file: stepText(r['file']), line: Number.isInteger(r['line']) ? Number(r['line']) : 0, symbol: stepText(r['symbol']),
  severity: stepText(r['severity']), tier: stepText(r['tier']), disposition: stepText(r['disposition']) || 'open',
  source: stepText(r['source']), ruleId: stepText(r['ruleId']), title: stepText(r['title']), why: stepText(r['why']),
  ...(stepText(r['toolRule']) ? { toolRule: stepText(r['toolRule']) } : {}),
  ...(Array.isArray(r['sources']) ? { sources: r['sources'] } : {}),
})

/** @param {Record<string, unknown>} v  a step with a run directory @returns {{ step: Step } | { error: string }} */
function pendingStep(v) {
  const tasks = v['tasks']
  if (v['done'] !== false || !Array.isArray(tasks) || !tasks.length || !tasks.every(isTask)) return { error: 'the step carries no well-formed tasks' }
  return { step: { run: /** @type {string} */ (v['run']), done: false, tasks, head: stepText(v['head']) } }
}

/** @typedef {(label: string, title: string, prompt: string) => Promise<unknown>} Serve */

/**
 * The binary to run and the plugin root to hand it: a given craftBin as is, with a given craftRoot checked first;
 * otherwise this version's released binary fetched, with the root its fetcher was found in.
 * @param {Options} o @param {string} craftVersion @param {Serve} serve
 * @returns {Promise<{ bin: string, root: string } | { incomplete: string }>}
 */
async function binAndRoot(o, craftVersion, serve) {
  if (o.craftBin === null) {
    const fetched = resolvedBin(await serve('step:resolve', 'Start', resolvePrompt(o, craftVersion)))
    return 'error' in fetched ? { incomplete: `cli-review could not get the craft binary ${craftVersion}: ${fetched.error}. Pass craftBin=<absolute path> of a build (\`cargo build --release\` in cli/).` } : fetched
  }
  if (!o.craftRoot) return { bin: o.craftBin, root: '' }
  const checked = checkedRoot(await serve('step:root', 'Start', rootPrompt(o)))
  return 'error' in checked
    ? { incomplete: `cli-review: craftRoot=${JSON.stringify(o.craftRoot)} is not a usable plugin root: ${checked.error}. Pass the absolute path of a craft plugin root (an installed copy, or a checkout's integrations/claude-code) outside the reviewed repo.` }
    : { bin: o.craftBin, root: checked.root }
}

/** @typedef {{ finished: Finished } | { stopped: string }} Ending */
/** @typedef {ReturnType<typeof cliRecorder>} Recorder */

/**
 * The run of one review: its record filed however it ended, then its answer — the verdict block, and the telemetry
 * section when a record write did not land. An argument refused before anything ran files no record: there is no
 * run, and no checkout it could be keyed to.
 * @param {Sandbox} sb @param {string} craftVersion @returns {Promise<string>}
 */
export async function runCliReview(sb, craftVersion) {
  const read = readOptions(normalizeArgs(sb.args, sb.log))
  if ('refused' in read) return stoppedAnswer(`cli-review: ${read.refused}. Nothing ran.`)
  const o = read.options
  const service = makeDefaultTypeFallback((/** @type {string} */ p, /** @type {Record<string, unknown>} */ opts) => sb.agent(p, opts), sb.log)
  const recorder = cliRecorder(sb, { craftVersion, repo: o.repo, depth: o.depth || 'full', service })
  const ending = await drive(sb, o, craftVersion, service, recorder)
  sb.phase('Record')
  await recorder.file('finished' in ending ? ending.finished : { verdict: 'INCOMPLETE', notRun: ['the craft binary did not finish the run'] })
  const answer = 'finished' in ending ? finishedAnswer(ending.finished) : stoppedAnswer(ending.stopped)
  const notes = recorder.notes()
  return notes ? `${answer}\n\n${notes}` : answer
}

/**
 * The whole loop: start, then rounds of agents and submits until the binary is done. Fails closed: a step that cannot
 * be read ends the run, saying where; a budget throw propagates. The start checkpoint goes down once the binary has
 * read the diff, naming the head it read.
 * @param {Sandbox} sb @param {Options} o @param {string} craftVersion
 * @param {import('./cli-review-record.mjs').Service} service @param {Recorder} recorder
 * @returns {Promise<Ending>}
 */
async function drive(sb, o, craftVersion, service, recorder) {
  /** @type {Serve} */
  const serve = (label, title, prompt) => service.run(prompt, { label, phase: title, schema: RUN_SCHEMA, model: 'haiku', effort: 'low', agentType: SERVICE_AGENT_TYPE })
  sb.log(`cli-review ${craftVersion}: ${o.craftBin ?? `the released binary ${craftVersion}`} over ${o.repo || 'the session checkout'}`)
  sb.phase('Start')
  const where = await binAndRoot(o, craftVersion, serve)
  if ('incomplete' in where) return { stopped: where.incomplete }
  recorder.at(where.root)
  const started = readStep(await serve('step:start', 'Start', startPrompt(o, where.bin, where.root)))
  if ('error' in started) return { stopped: `cli-review stopped at round 1: ${started.error}.` }
  await recorder.checkpoint()
  return rounds(sb, where.bin, started.step, serve)
}

/**
 * Rounds of agents and submits from `first` until the binary is done.
 * @param {Sandbox} sb @param {string} bin @param {Step} first @param {Serve} serve @returns {Promise<Ending>}
 */
async function rounds(sb, bin, first, serve) {
  const tasks = taskRunner(sb)
  /** @type {{ step: Step } | { error: string }} */
  let read = { step: first }
  for (let round = 1; ; round++) {
    if ('error' in read) return { stopped: `cli-review stopped at round ${round}: ${read.error}.` }
    const step = read.step
    if (step.done) return { finished: step }
    if (round > MAX_ROUNDS) return { stopped: `cli-review gave up after ${MAX_ROUNDS} rounds; the run is in ${step.run}.` }
    sb.phase('Agents')
    sb.log(`round ${round}: ${step.tasks.length} task(s) — ${step.tasks.map(t => t.label).join(', ')}`)
    // No schema: the binary checks each answer file. A dead agent leaves no file, which the binary asks for again.
    await sb.parallel(step.tasks.map(t => () => tasks.run(t)))
    sb.phase('Submit')
    read = readStep(await serve(`step:submit:${round}`, 'Submit', submitPrompt(bin, step.run, tasks.degraded(round))))
  }
}
