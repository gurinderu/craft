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
import { finishedAnswer, resumeHint, stoppedAnswer } from './cli-review-verdict.mjs'
import { limitWatch } from './cli-review-limit.mjs'
import { millis, runClock } from './cli-review-clock.mjs'
import { normalizeArgs } from './workflow-args.mjs'

/** @typedef {{ id: string, label: string, model: string, promptFile: string, schemaFile: string, answerFile: string, agentType?: string, consumerAgent?: string, kind?: string }} Task  consumerAgent: the reviewed repository's own agent, by the name it gives it; kind: what the task is for, by which its deadline is set */
/** @typedef {import('./cli-review-record.mjs').Finding} Finding */
/** @typedef {import('./cli-review-record.mjs').LedgerRow} LedgerRow */
/** @typedef {{ run: string, done: true, report: string, verdict: string, line: string, degraded: boolean, head: string, base: string, findings: Finding[], uncovered: string[], notRun: string[], round: number, lensScope: 'delta' | 'full', ledger: LedgerRow[] | null, reReview: Record<string, unknown> | null, memory: Record<string, unknown> | null, strict: boolean, stopped: boolean, repo: string, sorting: Record<string, unknown> | null, memoryContradictions: Record<string, unknown> | null, prComments: Record<string, unknown> | null, dimensions: Record<string, unknown>[], verification: Record<string, unknown> | null, lensRounds: Record<string, unknown>[] | null, at: number | null, took: number | null }} Finished  ledger, memory, sorting, memoryContradictions and prComments null when the binary sent none (sorting and prComments: a run without comment); stopped when the binary held the run on the usage limit, to be resumed; repo the repository the run reviews, '' when the binary named none; dimensions, verification and lensRounds what its lenses yielded and verification judged ([] and null when the binary sent none); at and took the binary's clock (lib/cli-review-clock.mjs), null when it sent none */
/** @typedef {{ run: string, done: false, tasks: Task[], head: string, repo: string, phase: string, at: number | null, took: number | null } | Finished} Step  phase: the binary's phase the tasks run in, '' when it names none */
/** @typedef {{ repo: string, base: string, depth: string, craftBin: string | null, craftRoot: string, fresh: boolean, fullEvery: string, strict: boolean, gate: boolean, priorDecisions: string, extraLenses: string, unitScope: boolean, path: string, run: string, comment: boolean }} Options  comment: publish the findings on the branch's PR; run the directory of a stopped or interrupted run to resume, '' to start one; craftBin shell-quoted, null until fetched; depth and fullEvery '' when not given; priorDecisions the JSON text of the launcher's list, '' when none; extraLenses the text of `--extra-lenses`, '' when not given; path the directory to review, '' for the whole change */
/** @typedef {(prompt: string, opts?: Record<string, unknown>) => Promise<unknown>} Agent */
/** @typedef {{ args: unknown, agent: Agent, parallel: <T>(thunks: Array<() => Promise<T>>) => Promise<Array<T | null>>, phase: (title: string) => void, log: (message: string) => void, budget?: { spent: () => number } }} Sandbox */

// The scout, a re-review's red team, up to three lens rounds, the dedup, verification in up to two waves (a split
// deciding pair buys the rest of its panel), the completeness critic, the lenses it admits with their dedup and
// verification in up to two waves, the memory's match judge and its rule judge — fifteen steps, each asked at most
// three times (the binary's two retries): forty-five rounds; three spare. Only a backstop: the binary decides when
// the run is done.
const MAX_ROUNDS = 48
// The fetcher of the released binary, inside the plugin.
const FETCHER = 'lib/craft-bin.mjs'
// The depths `craft review start --depth` takes.
const DEPTHS = new Set(['light', 'full'])
// The delimiter of the heredoc that hands the binary the launcher's records on its stdin.
const PRIOR_DECISIONS_EOF = 'CRAFT_PRIOR_DECISIONS'
// The start fetches the source of each integration point the reviewer's profile names (craft init) on its first
// run at that revision, within its own budget of 240 s (cli/crates/craft-review/src/sources/runner.rs), and beside it
// runs the mechanical gate's tools — clippy, semgrep, nix flake check, statix, deadnix — within theirs of 300 s
// (cli/crates/craft-review/src/gate.rs): longer than a Bash call's default two minutes allow, and inside this timeout.
const START_TIMEOUT = 'in one Bash call with a timeout of 600000 ms (it may fetch the source of each integration point the reviewer\'s profile names, and may build and lint the branch for the mechanical gate)'

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
  const bad = ['repo', 'craftBin', 'craftRoot', 'run'].find(k => a[k] != null && absolutePath(a[k]) === null)
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
 * What the binary is told beyond the diff: `strict` (the maintainability bar a presumption of block), `gate` (false: no
 * mechanical gate, which builds and runs the branch's code — clippy's build scripts and proc macros, nix flake check — for a
 * branch not trusted) and the launcher's
 * own records, `priorDecisions`, as JSON text — the binary reads and refuses them as the engine does (a string, or any
 * value that is no list, is named and nothing of it applied), and adds them to what it recalls from the project's memory.
 * @param {Record<string, unknown>} a @returns {{ strict: boolean, gate: boolean, priorDecisions: string } | { refused: string }}
 */
function memoryOptions(a) {
  const strict = a['strict'] ?? false
  if (strict !== true && strict !== false) return { refused: `strict=${JSON.stringify(strict)} is not true or false` }
  const gate = a['gate'] ?? true
  if (gate !== true && gate !== false) return { refused: `gate=${JSON.stringify(gate)} is not true or false` }
  const given = a['priorDecisions']
  return { strict, gate, priorDecisions: given == null ? '' : JSON.stringify(given) }
}

/**
 * The consumer's own agents to run as extra lenses (`extraLenses`), as the text `--extra-lenses` takes: a list's
 * names joined by commas, a string as it stands, `off` for false or an empty list, '' when absent (the binary then
 * discovers them on a light pass). The binary reads and refuses the names; any other value is refused here.
 * @param {Record<string, unknown>} a @returns {{ extraLenses: string } | { refused: string }}
 */
function extraLensOption(a) {
  const v = a['extraLenses']
  if (v == null) return { extraLenses: '' }
  if (v === false || (Array.isArray(v) && !v.length)) return { extraLenses: 'off' }
  const names = Array.isArray(v) && v.every(x => typeof x === 'string') ? v.join(',') : v
  if (typeof names !== 'string' || hasControl(names)) return { refused: `extraLenses=${JSON.stringify(v)} is not a list of agent names` }
  return { extraLenses: names.trim() || 'off' }
}

/**
 * Unit mode (`unitScope`, off by default; realm @nick/craft, #362): passed through as `--unit-scope`; the binary
 * discovers the units, slices the change and says why when it cannot.
 * @param {Record<string, unknown>} a @returns {{ unitScope: boolean } | { refused: string }}
 */
function unitOption(a) {
  const unitScope = a['unitScope'] ?? false
  return unitScope === true || unitScope === false ? { unitScope } : { refused: `unitScope=${JSON.stringify(unitScope)} is not true or false` }
}

/**
 * The directory of the change to review (`path`, as rust-audit scopes a crate's review), passed through as `--path`;
 * the binary reads it repository-relative, or absolute inside the repository, and refuses one outside it.
 * @param {Record<string, unknown>} a @returns {{ path: string } | { refused: string }}
 */
function pathOption(a) {
  const v = a['path'] ?? ''
  return typeof v === 'string' && !hasControl(v) ? { path: v.trim() } : { refused: `path=${JSON.stringify(v)} is not a path` }
}

/**
 * Publishing on the PR (`comment`, off by default; realm @nick/craft, #194, #270): passed through as `--comment`; the
 * binary sorts the findings, posts the defects with gh itself and says what landed.
 * @param {Record<string, unknown>} a @returns {{ comment: boolean } | { refused: string }}
 */
function commentOption(a) {
  const comment = a['comment'] ?? false
  return comment === true || comment === false ? { comment } : { refused: `comment=${JSON.stringify(comment)} is not true or false` }
}

/**
 * The stopped or interrupted run to resume (`run`), '' to start one; a value that is no absolute path is refused by
 * badPath before this reads it.
 * @param {Record<string, unknown>} a @returns {{ run: string }}
 */
const runOption = a => ({ run: absolutePath(a['run']) ?? '' })

/**
 * What the binary decides the review by beyond the diff and its base: the round chain's options, the memory's, the
 * extra lenses, unit mode, the scope, publishing on the PR and the run to resume.
 * @param {Record<string, unknown>} a
 * @returns {{ fresh: boolean, fullEvery: string, strict: boolean, gate: boolean, priorDecisions: string, extraLenses: string, unitScope: boolean, path: string, run: string, comment: boolean } | { refused: string }}
 */
function reviewOptions(a) {
  /** @type {Array<Record<string, unknown>>} */
  const parts = []
  for (const read of [roundOptions, memoryOptions, extraLensOption, unitOption, pathOption, runOption, commentOption]) {
    const got = read(a)
    if ('refused' in got) return got
    parts.push(got)
  }
  return /** @type {{ fresh: boolean, fullEvery: string, strict: boolean, gate: boolean, priorDecisions: string, extraLenses: string, unitScope: boolean, path: string, run: string, comment: boolean }} */ (Object.assign({}, ...parts))
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
  const review = reviewOptions(a)
  if ('refused' in review) return review
  const bin = absolutePath(a['craftBin'])
  return { options: { repo: absolutePath(a['repo']) ?? '', base, depth: String(depth), craftBin: bin ? shq(bin) : null, craftRoot: absolutePath(a['craftRoot']) ?? '', ...review } }
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
 * The start's flags for the round chain, strict mode, the gate, the extra lenses, unit mode, the scope and publishing on the PR, each only when it
 * differs from the binary's default.
 * @param {Options} o @returns {string}
 */
const reviewFlags = o => `${o.fresh ? ' --fresh' : ''}${o.fullEvery ? ` --full-every ${o.fullEvery}` : ''}${o.strict ? ' --strict' : ''}${o.gate ? '' : ' --no-gate'}${o.extraLenses ? ` --extra-lenses ${shq(o.extraLenses)}` : ''}${o.unitScope ? ' --unit-scope' : ''}${o.path ? ` --path ${shq(o.path)}` : ''}${o.comment ? ' --comment' : ''}`

/**
 * The binary stores the root in the run's state, so submit renders its retries and verifiers with the same one.
 * @param {Options} o @param {string} bin @param {string} root  the plugin root its prompts name, '' to let it look above itself
 * @returns {string}
 */
function startPrompt(o, bin, root) {
  const cmd = `${bin} review start --cwd ${o.repo ? shq(o.repo) : '.'}${o.base ? ` --base ${shq(o.base)}` : ''}${o.depth ? ` --depth ${o.depth}` : ''}${reviewFlags(o)}${root ? ` --craft-root ${shq(root)}` : ''}`
  if (!o.priorDecisions) return servicePrompt(`Run exactly this one command, ${START_TIMEOUT}:\n\n${cmd}`)
  // One line of JSON (JSON.stringify escapes every newline), so no line of it can be the quoted heredoc's delimiter.
  return servicePrompt(`Run exactly this one command, ${START_TIMEOUT}, the line between the heredoc's markers copied character for character:\n\n${cmd} --prior-decisions - <<'${PRIOR_DECISIONS_EOF}'\n${o.priorDecisions}\n${PRIOR_DECISIONS_EOF}`)
}

/**
 * The submit, with a `--degraded` note for each way the step's tasks ran weaker than asked, kept for the report, the
 * usage limit's text when an agent of the step ran into it (`--limit`), which stops the run, and `--resume` when it
 * resumes a run (`run=`): an answer still missing is then handed out again, not counted as a failed attempt; and an
 * `--abandoned` for each task whose agent was abandoned at its deadline, which the binary fails at once.
 * @param {string} bin @param {string} run @param {{ degraded?: string[], limit?: string, resume?: boolean, abandoned?: string[] }} said @returns {string}
 */
const submitPrompt = (bin, run, { degraded = [], limit = '', resume = false, abandoned = [] }) => servicePrompt(`Run exactly this one command:\n\n${bin} review submit --run ${shq(run)}${degraded.map(n => ` --degraded ${shq(n)}`).join('')}${abandoned.map(id => ` --abandoned ${shq(id)}`).join('')}${limit ? ` --limit ${shq(limit)}` : ''}${resume ? ' --resume' : ''}`)

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)

/** @param {unknown} t @returns {t is Task} */
function isTask(t) {
  if (!isObject(t)) return false
  const s = /** @param {string} k */ k => typeof t[k] === 'string'
  const file = /** @param {string} k */ k => absolutePath(t[k]) !== null
  const optional = /** @param {string} k */ k => t[k] === undefined || s(k)
  return s('id') && s('label') && isTaskModel(t['model']) && file('promptFile') && file('schemaFile') && file('answerFile') && optional('agentType') && optional('consumerAgent') && optional('kind')
}

/**
 * The command's output from a service answer, or why there is none.
 * @param {unknown} got @returns {{ stdout: string } | { error: string }}
 */
function commandOutput(got) {
  // The note a parent reads a nested run's stop by (limitInReport, lib/limit-report.mjs).
  if (isObject(got) && typeof got['limit'] === 'string') return { error: `stopped: usage limit reached (${got['limit']})` }
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
      memory: isObject(v['memory']) ? v['memory'] : null, strict: v['strict'] === true, stopped: isObject(v['stopped']), repo: stepText(v['repo']),
      ...roundOf(v), ...publicationOf(v), ...telemetryOf(v), ...clockOf(v),
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

/**
 * What a finished step says of publishing on the PR: the sorting, the findings going against memory and what was posted,
 * each null when the binary sent none.
 * @param {Record<string, unknown>} v
 */
const publicationOf = v => ({
  sorting: isObject(v['sorting']) ? v['sorting'] : null,
  memoryContradictions: isObject(v['memoryContradictions']) ? v['memoryContradictions'] : null,
  prComments: isObject(v['prComments']) ? v['prComments'] : null,
})

/**
 * What a finished step says its lenses yielded and its verification judged, in the engine's record shape: the rows,
 * `[]` when it sent none; the verification and the lens rounds, null when it sent none.
 * @param {Record<string, unknown>} v
 */
const telemetryOf = v => ({
  dimensions: Array.isArray(v['dimensions']) ? v['dimensions'].filter(isObject) : [],
  verification: isObject(v['verification']) ? v['verification'] : null,
  lensRounds: Array.isArray(v['lensRounds']) ? v['lensRounds'].filter(isObject) : null,
})

/** The binary's clock on a step: when it printed it and how long its command ran. @param {Record<string, unknown>} v */
const clockOf = v => ({ at: millis(v['at']), took: millis(v['took']) })

/** One row of the binary's ledger, its fields as strings and its line a number. @param {Record<string, unknown>} r @returns {LedgerRow} */
const ledgerRowOf = r => ({
  file: stepText(r['file']), line: Number.isInteger(r['line']) ? Number(r['line']) : 0, symbol: stepText(r['symbol']),
  severity: stepText(r['severity']), tier: stepText(r['tier']), disposition: stepText(r['disposition']) || 'open',
  source: stepText(r['source']), ruleId: stepText(r['ruleId']), title: stepText(r['title']), why: stepText(r['why']),
  ...(stepText(r['toolRule']) ? { toolRule: stepText(r['toolRule']) } : {}),
  ...(Array.isArray(r['sources']) ? { sources: r['sources'] } : {}),
  ...(isObject(r['deferral']) ? { deferral: r['deferral'] } : {}),
})

/** @param {Record<string, unknown>} v  a step with a run directory @returns {{ step: Step } | { error: string }} */
function pendingStep(v) {
  const tasks = v['tasks']
  if (v['done'] !== false || !Array.isArray(tasks) || !tasks.length || !tasks.every(isTask)) return { error: 'the step carries no well-formed tasks' }
  return { step: { run: /** @type {string} */ (v['run']), done: false, tasks, head: stepText(v['head']), repo: stepText(v['repo']), phase: stepText(v['phase']), ...clockOf(v) } }
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

/**
 * The step a resumed run (`run`) goes on from: the binary's submit over the run directory, which hands a stopped run's
 * held tasks out again and reads an interrupted one's answer files. Only the binary's own refusal — the command ran
 * and exited 1, the exit of every error it reports: no state.json of its current format, or a finished run — names the
 * directory as no run, and `refused` says so, so no resume of it is offered. A command cut off (a timeout's 124, a
 * signal's 128 and above) or a service agent that died (under the account's limit agent() usually comes back null with
 * no text, realm @nick/craft, #300) or ran into the limit is reported as itself.
 * @param {string} run @param {unknown} got @returns {{ step: Step } | { error: string, refused?: true }}
 */
function resumed(run, got) {
  const read = readStep(got)
  const refused = isObject(got) && got['exitCode'] === BINARY_REFUSED
  if (!('error' in read) || !refused) return read
  return { error: `run=${JSON.stringify(run)} is not a craft run directory this binary can resume (no state.json of its current format, or a finished run): ${read.error}`, refused: true }
}

/** The exit of a `craft` command that reported an error (main.rs: `ExitCode::FAILURE`). */
const BINARY_REFUSED = 1

/**
 * Why the run stopped at `round`, and, whenever a run directory is known, where it is and how to resume it: the
 * account's limit often leaves no text at all, so no error is told apart here.
 * @param {number} round @param {string} error @param {string} run  the run directory, '' when none is known
 * @returns {string}
 */
const stoppedAt = (round, error, run) => `cli-review stopped at round ${round}: ${error}.${run ? ` The run is in ${run}. ${resumeHint(run)}` : ''}`

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
  const limit = limitWatch()
  // The task agents counted for the record's runtimeStats, and the binary's clock read off its steps.
  const clock = runClock()
  const watched = limit.service((p, opts) => sb.agent(p, opts))
  const service = makeDefaultTypeFallback((/** @type {string} */ p, /** @type {Record<string, unknown>} */ opts) => watched(p, opts), sb.log, () => !!limit.seen())
  const recorder = cliRecorder(sb, { craftVersion, repo: o.repo, depth: o.depth || 'full', strict: o.strict, service })
  const ending = await drive({ ...sb, limit, clock }, o, craftVersion, service, recorder)
  sb.phase('Record')
  // A resumed run whose resume ended before the binary named its repository, with none given, has no checkout to key
  // a record to: filing it under the session's would put it in another repository's history.
  const unkeyed = !!o.run && !recorder.keyed()
  const runtimeStats = clock.stats()
  if (!unkeyed) await recorder.file('finished' in ending ? { ...ending.finished, runtimeStats } : { verdict: 'INCOMPLETE', notRun: ['the craft binary did not finish the run'], runtimeStats })
  const answer = 'finished' in ending ? finishedAnswer(ending.finished) : stoppedAnswer(ending.stopped)
  const notes = [unkeyed ? 'No run record was filed: the resumed run\'s repository is unknown (the resume ended before the binary named it, and no repo= was given).' : '', recorder.notes()].filter(Boolean).join('\n\n')
  return notes ? `${answer}\n\n${notes}` : answer
}

/** @typedef {Sandbox & { limit: ReturnType<typeof limitWatch>, clock: ReturnType<typeof runClock> }} Watched */

/**
 * The whole loop: start, then rounds of agents and submits until the binary is done. Fails closed: a step that cannot
 * be read ends the run, saying where; a budget throw propagates. The start checkpoint goes down once the binary has
 * read the diff, naming the head it read. A service step that came back with nothing once the usage limit was seen
 * stopped on it.
 * @param {Watched} sb @param {Options} o @param {string} craftVersion
 * @param {import('./cli-review-record.mjs').Service} service @param {Recorder} recorder
 * @returns {Promise<Ending>}
 */
async function drive(sb, o, craftVersion, service, recorder) {
  /** @type {Serve} */
  const serve = async (label, title, prompt) => {
    const got = await service.run(prompt, { label, phase: title, schema: RUN_SCHEMA, model: 'haiku', effort: 'low', agentType: SERVICE_AGENT_TYPE })
    return got == null && sb.limit.seen() ? { limit: sb.limit.seen() } : got
  }
  sb.log(`cli-review ${craftVersion}: ${o.craftBin ?? `the released binary ${craftVersion}`} over ${o.repo || 'the session checkout'}`)
  sb.phase('Start')
  const where = await binAndRoot(o, craftVersion, serve)
  if ('incomplete' in where) return { stopped: where.incomplete }
  recorder.at(where.root)
  const started = o.run ? resumed(o.run, await serve('step:resume', 'Start', submitPrompt(where.bin, o.run, { resume: true }))) : readStep(await serve('step:start', 'Start', startPrompt(o, where.bin, where.root)))
  if ('error' in started) return { stopped: stoppedAt(1, started.error, 'refused' in started ? '' : o.run) }
  // A resumed run's record is keyed to the repository the run reviews, which the binary names.
  if (o.run && started.step.repo) recorder.keyTo(started.step.repo)
  sb.clock.observe(started.step)
  await recorder.checkpoint()
  return rounds(sb, where.bin, started.step, serve, recorder)
}

/**
 * Rounds of agents and submits from `first` until the binary is done. Once a task agent ran into the usage limit no
 * other is dispatched, and the submit hands the binary its text, which ends the run. As each of the binary's phases
 * ends, its checkpoint goes down beside the next round's agents, with what it cost.
 * @param {Watched} sb @param {string} bin @param {Step} first @param {Serve} serve @param {Recorder} recorder
 * @returns {Promise<Ending>}
 */
async function rounds(sb, bin, first, serve, recorder) {
  // Only the task agents are counted for the record's runtimeStats.agents: the work the review dispatched, as the
  // engine's agents are its review agents; the service steps that run the binary and the record's writes are not.
  // Counted inside the limit's watch, so a call it answers without dispatching once the limit is seen is not.
  const tasks = taskRunner({ ...sb, agent: sb.limit.tasks(sb.clock.counted(sb.agent)) }, () => !!sb.limit.seen())
  /** @type {{ step: Step } | { error: string }} */
  let read = { step: first }
  for (let round = 1; ; round++) {
    if ('error' in read) return { stopped: stoppedAt(round, read.error, first.run) }
    const step = read.step
    if (step.done) return { finished: step }
    if (round > MAX_ROUNDS) return { stopped: `cli-review gave up after ${MAX_ROUNDS} rounds; the run is in ${step.run}.` }
    sb.phase('Agents')
    sb.log(`round ${round}: ${step.tasks.length} task(s) — ${step.tasks.map(t => t.label).join(', ')}`)
    // No schema: the binary checks each answer file. A dead agent leaves no file, which the binary asks for again.
    await sb.parallel(step.tasks.map(t => () => tasks.run(t)))
    sb.phase('Submit')
    if (sb.limit.seen()) sb.log(`\u26d4 usage limit reached (${sb.limit.seen()}) — no further review agents are dispatched; the run reports what it has as INCOMPLETE`)
    read = readStep(await serve(`step:submit:${round}`, 'Submit', submitPrompt(bin, step.run, { degraded: tasks.degraded(round), abandoned: tasks.abandoned(), limit: sb.limit.seen() })))
    if ('step' in read) await phaseEnded(sb.clock, recorder, read.step, step.head)
  }
}

/**
 * The checkpoint of the binary's phase `next` ends, with what it cost; not waited for beside the next round's agents,
 * but the last, once the run is done, before its figures are read.
 * @param {Watched['clock']} clock @param {Recorder} recorder @param {Step} next @param {string} head @returns {Promise<void>}
 */
async function phaseEnded(clock, recorder, next, head) {
  const ended = clock.observe(next)
  if (!ended) return
  const slice = recorder.checkpoint(ended.phase, { minutes: ended.minutes, agents: ended.agents, head })
  if (next.done) await slice
}
