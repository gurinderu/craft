// The Claude Code driver of the CLI's step protocol (src/review.js; realm @nick/craft, node #453): the `craft`
// binary decides what a review needs and starts no agent, this driver runs the agents each step hands out and
// hands their answers back. It holds no review logic: what to ask, of which model, in which shape, and what the
// answers mean are all the binary's. The sandbox reads no file and spawns no process (#134), so a service agent runs
// the binary and returns its small JSON verbatim; the prompts, schemas and answers themselves travel as files in the
// run directory — each task's agent reads its prompt file and writes its answer file — so no model copies them.
// The binary files the run's telemetry itself — a checkpoint as each of its phases ends, the record when the run
// finishes, through lib/cli-review-file.mjs and the one write path, lib/craft-log-run.mjs (realm @nick/craft, node
// #456) — told by each submit what only the driver sees: the task agents dispatched and the output tokens spent. The
// driver files only the record of a run the binary never finished (lib/cli-review-record.mjs), and locates the
// plugin's lib/craft-bin.mjs the way every plugin script an agent runs is located (plugin-script.mjs).
import { pluginRootCheck, pluginScriptPrelude, shq } from './plugin-script.mjs'
import { SERVICE_AGENT_TYPE, makeDefaultTypeFallback } from './service-agent.mjs'
import { taskRunner } from './cli-review-task.mjs'
import { cliRecorder } from './cli-review-record.mjs'
import { finishedAnswer, resumeHint, stoppedAnswer } from './cli-review-verdict.mjs'
import { limitWatch } from './cli-review-limit.mjs'
import { runClock } from './cli-review-clock.mjs'
import { argumentProblem, hasControl, launchFlags, launchOptions, viaName } from './cli-review-keys.mjs'
import { absolutePath, commandOutput, isObject, readStep } from './cli-review-step.mjs'
import { endedOf } from './cli-review-ended.mjs'
import { gateAnswer, gateCommand } from './cli-review-gate.mjs'
import { telemetryLostSection } from './review-coverage.mjs'
import { argumentRefusal } from './run-record.mjs'
import { normalizeArgs } from './workflow-args.mjs'

/** @typedef {{ repo: string, base: string, depth: string, craftBin: string | null, craftRoot: string, fresh: boolean, fullEvery: string, strict: boolean, gate: boolean, priorDecisions: string, extraLenses: string, unitScope: boolean, path: string, run: string, comment: boolean, optional: string, via: string, recalled: boolean, gateOnly: boolean, gateFrom: string, pr: string }} Options  pr: the pull request a finished run is published on (`run` with `comment`), '' for the reviewed branch's; gateOnly: run the mechanical gate alone (`craft review gate`), no review; gateFrom: the directory of a gate run alone to take rather than run one ('' none); optional: the text of `--optional`, '' for none; via: the parent engine that launched the run, '' when none; recalled: the launcher recalled the memory itself (`--no-recall`); comment: publish the findings on the branch's PR; run the directory of a stopped or interrupted run to resume, '' to start one; craftBin shell-quoted, null until fetched; depth and fullEvery '' when not given; priorDecisions the JSON text of the launcher's list, '' when none; extraLenses the text of `--extra-lenses`, '' when not given; path the directory to review, '' for the whole change */
/** @typedef {import('./cli-review-step.mjs').Step} Step */
/** @typedef {import('./cli-review-step.mjs').Finished} Finished */
/** @typedef {(prompt: string, opts?: Record<string, unknown>) => Promise<unknown>} Agent */
/** @typedef {{ args: unknown, agent: Agent, parallel: <T>(thunks: Array<() => Promise<T>>) => Promise<Array<T | null>>, phase: (title: string) => void, log: (message: string) => void, budget?: { spent: () => number } }} Sandbox */

// The scout, a re-review's red team, up to three lens rounds, unit mode's coordinator (the Seam phase), the dedup,
// verification in up to two waves (a split deciding pair buys the rest of its panel), the completeness critic, the
// lenses it admits with their dedup and verification in up to two waves, the memory's match judge and its rule judge —
// sixteen steps, each asked at most three times (the binary's two retries): forty-eight rounds; three spare. Only a
// backstop: the binary decides when the run is done.
const MAX_ROUNDS = 51
// The fetcher of the released binary, inside the plugin.
const FETCHER = 'lib/craft-bin.mjs'
// The run-record writer the binary files the run's telemetry through, inside the plugin (cli/crates/craft-review/src/filing/node.rs).
const WRITER = 'lib/cli-review-file.mjs'
// The depths `craft review start --depth` takes.
const DEPTHS = new Set(['light', 'full'])
// The delimiter of the heredoc that hands the binary the launcher's records on its stdin.
const PRIOR_DECISIONS_EOF = 'CRAFT_PRIOR_DECISIONS'
// The start fetches the source of each integration point the reviewer's profile names (craft init) on its first
// run at that revision, within its own budget of 240 s (cli/crates/craft-review/src/sources/runner.rs), and beside it
// runs the mechanical gate's tools — clippy, semgrep, nix flake check, statix, deadnix — within theirs of 300 s
// (cli/crates/craft-review/src/gate.rs): longer than a Bash call's default two minutes allow, and inside this timeout.
// A submit may file the run's telemetry — a stopped part's record, a checkpoint and the record, each bounded at 60 s
// (cli/crates/craft-review/src/filing/node.rs) — and post the findings on the PR within 75 s
// (cli/crates/craft-review/src/publish/gh.rs): past a Bash call's default two minutes, so seven with headroom.
const SUBMIT_TIMEOUT = 'in one Bash call with a timeout of 420000 ms (it may file the run\'s telemetry through node and post review comments on the PR)'
const START_TIMEOUT = 'in one Bash call with a timeout of 600000 ms (it may fetch the source of each integration point the reviewer\'s profile names, and may build and lint the branch for the mechanical gate)'

/** What a service step returns: the command's exit status and its output, copied whole. */
const RUN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['exitCode', 'stdout', 'stderr'],
  properties: { exitCode: { type: 'integer' }, stdout: { type: 'string' }, stderr: { type: 'string' } },
}

/** Why `a` names an option path that is not absolute, '' when none does. @param {Record<string, unknown>} a @returns {string} */
function badPath(a) {
  const bad = ['repo', 'craftBin', 'craftRoot', 'run', 'gateFrom'].find(k => a[k] != null && absolutePath(a[k]) === null)
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
 * badPath before this reads it. With it, the pull request a finished run is published on (`pr`, checked by
 * lib/cli-review-keys.mjs), '' when none is named.
 * @param {Record<string, unknown>} a @returns {{ run: string, pr: string }}
 */
const runOption = a => ({ run: absolutePath(a['run']) ?? '', pr: a['pr'] == null ? '' : String(a['pr']) })

/**
 * The gate alone (`gateOnly`), and a kept gate to take (`gateFrom`, checked absolute by badPath), whose values and
 * companions lib/cli-review-keys.mjs has checked.
 * @param {Record<string, unknown>} a @returns {{ gateOnly: boolean, gateFrom: string }}
 */
const gateOnlyOption = a => ({ gateOnly: a['gateOnly'] === true, gateFrom: absolutePath(a['gateFrom']) ?? '' })

/**
 * What the binary decides the review by beyond the diff and its base: the round chain's options, the memory's, the
 * extra lenses, unit mode, the scope, publishing on the PR, the run to resume and the launch options.
 * @param {Record<string, unknown>} a
 * @returns {Omit<Options, 'repo' | 'base' | 'depth' | 'craftBin' | 'craftRoot'> | { refused: string }}
 */
function reviewOptions(a) {
  /** @type {Array<Record<string, unknown>>} */
  const parts = []
  for (const read of [roundOptions, memoryOptions, extraLensOption, unitOption, pathOption, runOption, commentOption, launchOptions, gateOnlyOption]) {
    const got = read(a)
    if ('refused' in got) return got
    parts.push(got)
  }
  return /** @type {Omit<Options, 'repo' | 'base' | 'depth' | 'craftBin' | 'craftRoot'>} */ (Object.assign({}, ...parts))
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
${rootAbove('CRAFT_FETCHER')}printf 'root=%s\\nbin=%s\\n' "$CRAFT_ROOT_PATH" "$CRAFT_BIN_PATH"
\`\`\``, 'two lines, root=<the plugin root> and bin=<the binary\'s path>,')
}

/**
 * The shell that sets CRAFT_ROOT_PATH to the plugin root holding the script located in `varName` (two directories up,
 * `lib/<script>`), as the Windows binary reads it when cygpath is there. @param {string} varName @returns {string}
 */
const rootAbove = varName => `CRAFT_ROOT_PATH="$(dirname "$(dirname "$${varName}")")"
if command -v cygpath >/dev/null 2>&1; then CRAFT_ROOT_PATH="$(cygpath -m "$CRAFT_ROOT_PATH")"; fi
`

/**
 * The step that locates the plugin root beside a given craftBin with no craftRoot, for the run's telemetry only: it is
 * filed through the run-record writer in it whatever binary runs (realm @nick/craft, node #456), and a binary outside
 * any plugin finds none above itself; the prompts keep the binary's own root. Located like the fetcher — the plugin root the harness names, then this version's installed
 * copy, never inside the reviewed repo — and printed as the root a given craftRoot is.
 * @param {Options} o @param {string} version @returns {string}
 */
function locatePrompt(o, version) {
  const locate = pluginScriptPrelude(undefined, version, o.repo, WRITER, 'CRAFT_ADAPTER')
  return servicePrompt(`Run this ONCE, exactly as written, in one Bash call:

\`\`\`sh
${locate}if [ -z "\${CRAFT_ADAPTER:-}" ]; then printf '%s\\n' "no usable ${WRITER} — \${CRAFT_ADAPTER_WHY}" >&2; exit 1; fi
${rootAbove('CRAFT_ADAPTER')}printf 'root=%s\\n' "$CRAFT_ROOT_PATH"
\`\`\``, 'one line, root=<the plugin root>,')
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
 * The start's flags for the round chain, strict mode, the gate, the extra lenses, unit mode, the scope, publishing on the
 * PR and the launch options, each only when it differs from the binary's default.
 * @param {Options} o @returns {string}
 */
const reviewFlags = o => `${o.fresh ? ' --fresh' : ''}${o.fullEvery ? ` --full-every ${o.fullEvery}` : ''}${o.strict ? ' --strict' : ''}${o.gate ? '' : ' --no-gate'}${o.gateFrom ? ` --gate-from ${shq(o.gateFrom)}` : ''}${o.extraLenses ? ` --extra-lenses ${shq(o.extraLenses)}` : ''}${o.unitScope ? ' --unit-scope' : ''}${o.path ? ` --path ${shq(o.path)}` : ''}${o.comment ? ' --comment' : ''}${launchFlags(o)}`

/**
 * The binary stores the root in the run's state, so submit renders its retries and verifiers with the same one, and
 * finds the run-record adapter in it. `--record` has the binary file the run's telemetry itself under this engine's
 * version, `--via` naming the parent engine a nested run's record is filed under, `--record-root` the plugin root it is
 * filed through when that is not the one the prompts name.
 * @param {Options} o @param {{ bin: string, root: string, recordRoot?: string }} where  the binary; the plugin root its
 *   prompts name, '' to let it look above itself; the root the run is filed through, when only that was located
 * @param {string} version  the engine's craft version
 * @returns {string}
 */
function startPrompt(o, { bin, root, recordRoot }, version) {
  const record = `${recordRoot ? ` --record-root ${shq(recordRoot)}` : ''} --record ${shq(version)}${o.via ? ` --via ${shq(o.via)}` : ''}`
  const cmd = `${bin} review start --cwd ${o.repo ? shq(o.repo) : '.'}${o.base ? ` --base ${shq(o.base)}` : ''}${o.depth ? ` --depth ${o.depth}` : ''}${reviewFlags(o)}${root ? ` --craft-root ${shq(root)}` : ''}${record}`
  if (!o.priorDecisions) return servicePrompt(`Run exactly this one command, ${START_TIMEOUT}:\n\n${cmd}`)
  // One line of JSON (JSON.stringify escapes every newline), so no line of it can be the quoted heredoc's delimiter.
  return servicePrompt(`Run exactly this one command, ${START_TIMEOUT}, the line between the heredoc's markers copied character for character:\n\n${cmd} --prior-decisions - <<'${PRIOR_DECISIONS_EOF}'\n${o.priorDecisions}\n${PRIOR_DECISIONS_EOF}`)
}

/**
 * The submit, with a `--degraded` note for each way the step's tasks ran weaker than asked, kept for the report, the
 * usage limit's text when an agent of the step ran into it (`--limit`), which stops the run, and `--resume` when it
 * resumes a run (`run=`): an answer still missing is then handed out again, not counted as a failed attempt, and the
 * plugin root known now goes with it (`--record-root`), which files a run started with none known; and an
 * `--abandoned` for each task whose agent was abandoned at its deadline, which the binary fails at once. Then what
 * the binary's telemetry needs and only the driver sees: the task agents dispatched so far (`--agents`) and the
 * output tokens the run has spent (`--output-tokens`, when the sandbox counts them).
 * @param {string} bin @param {string} run @param {{ degraded?: string[], limit?: string, resume?: boolean, recordRoot?: string, abandoned?: string[] }} said
 * @param {{ agents: number, tokens: number | null }} spent @returns {string}
 */
const submitPrompt = (bin, run, { degraded = [], limit = '', resume = false, recordRoot = '', abandoned = [] }, { agents, tokens }) => servicePrompt(`Run exactly this one command, ${SUBMIT_TIMEOUT}:\n\n${bin} review submit --run ${shq(run)}${degraded.map(n => ` --degraded ${shq(n)}`).join('')}${abandoned.map(id => ` --abandoned ${shq(id)}`).join('')}${limit ? ` --limit ${shq(limit)}` : ''}${resume ? ' --resume' : ''}${recordRoot ? ` --record-root ${shq(recordRoot)}` : ''} --agents ${agents}${tokens === null ? '' : ` --output-tokens ${tokens}`}`)


/** @typedef {(label: string, title: string, prompt: string) => Promise<unknown>} Serve */

/**
 * The binary to run and the plugin root to hand it: a given craftBin as is, with a given craftRoot checked first, or
 * the root located only to file the run through (`recordRoot`; `note` saying why none was) — the prompts keep the
 * binary's own, so a local build is not run with another plugin's content; otherwise this version's released binary
 * fetched, with the root its fetcher was found in.
 * @param {Options} o @param {string} craftVersion @param {Serve} serve
 * @returns {Promise<{ bin: string, root: string, recordRoot?: string, note?: string } | { incomplete: string }>}
 */
async function binAndRoot(o, craftVersion, serve) {
  if (o.craftBin === null) {
    const fetched = resolvedBin(await serve('step:resolve', 'Start', resolvePrompt(o, craftVersion)))
    return 'error' in fetched ? { incomplete: `review could not get the craft binary ${craftVersion}: ${fetched.error}. Pass craftBin=<absolute path> of a build (\`cargo build --release\` in cli/).` } : fetched
  }
  if (!o.craftRoot) {
    const located = checkedRoot(await serve('step:locate', 'Start', locatePrompt(o, craftVersion)))
    // None located: the binary still looks above itself and at CLAUDE_PLUGIN_ROOT.
    return 'error' in located ? { bin: o.craftBin, root: '', note: `no craft plugin root was located for the run's telemetry: ${located.error}` } : { bin: o.craftBin, root: '', recordRoot: located.root }
  }
  const checked = checkedRoot(await serve('step:root', 'Start', rootPrompt(o)))
  return 'error' in checked
    ? { incomplete: `review: craftRoot=${JSON.stringify(o.craftRoot)} is not a usable plugin root: ${checked.error}. Pass the absolute path of a craft plugin root (an installed copy, or a checkout's integrations/claude-code) outside the reviewed repo.` }
    : { bin: o.craftBin, root: checked.root }
}

/**
 * The step a resumed run (`run`) goes on from: the binary's submit over the run directory, which hands a stopped run's
 * held tasks out again and reads an interrupted one's answer files. Only the binary's own refusal — the command ran
 * and exited 1, the exit of every error it reports: no state.json of its current format, a finished run, or a
 * checkout whose HEAD or tracked files moved since the run started — is a run that cannot be resumed, said in the
 * binary's own words, and `refused` says so, so no resume of it is offered. A command cut off (a timeout's 124, a
 * signal's 128 and above) or a service agent that died (under the account's limit agent() usually comes back null with
 * no text, realm @nick/craft, #300) or ran into the limit is reported as itself.
 * @param {string} run @param {unknown} got @param {string} [done]  what the binary refused to do with the run
 * @returns {{ step: Step } | { error: string, refused?: true }}
 */
function resumed(run, got, done = 'resumed') {
  const read = readStep(got)
  if (!('error' in read) || !isObject(got) || got['exitCode'] !== BINARY_REFUSED) return read
  const why = String(got['stderr'] ?? '').trim().replace(/^craft: /, '').slice(0, 400)
  return { error: `run=${JSON.stringify(run)} cannot be ${done}: ${why || read.error}`, refused: true }
}

/** The exit of a `craft` command that reported an error (main.rs: `ExitCode::FAILURE`). */
const BINARY_REFUSED = 1

/**
 * Why the run stopped at `round`, and, whenever a run directory is known, where it is and how to resume it: the
 * account's limit often leaves no text at all, so no error is told apart here.
 * @param {number} round @param {string} error @param {string} run  the run directory, '' when none is known
 * @returns {string}
 */
const stoppedAt = (round, error, run) => `review stopped at round ${round}: ${error}.${run ? ` The run is in ${run}. ${resumeHint(run)}` : ''}`

/** @typedef {{ finished: Finished } | { stopped: string } | { unrecorded: string }} Ending  unrecorded: the binary finished the run but left nothing to file its record from */
/** @typedef {ReturnType<typeof cliRecorder>} Recorder */

/**
 * The run of one review, then its answer — the verdict block, and the telemetry section when a write did not land. A
 * run the binary finished was filed by the binary itself (`filing` on its steps); only one the binary never finished
 * — its step unreadable, the round backstop, a resume refused — is filed here, INCOMPLETE, into the run directory the
 * binary's checkpoints went to. An argument refused before anything ran files only its refusal.
 * @param {Sandbox} sb @param {string} craftVersion @returns {Promise<string>}
 */
export async function runCliReview(sb, craftVersion) {
  const a = normalizeArgs(sb.args, sb.log)
  const problem = argumentProblem(a, readOptions)
  if (problem) return refuse(sb, craftVersion, a, problem)
  const o = /** @type {{ options: Options }} */ (readOptions(a)).options
  const { limit, service } = serviceOf(sb)
  const one = oneStep(sb, o, craftVersion, serveWith(service, limit))
  if (one) return one
  // The task agents counted for the binary's runtimeStats, and the binary's clock read off its steps for the record of
  // a run it never finished.
  const clock = runClock()
  const recorder = cliRecorder(sb, { craftVersion, repo: o.repo, depth: o.depth || 'full', strict: o.strict, via: o.via, service })
  const ending = await drive({ ...sb, limit, clock }, o, craftVersion, service, recorder)
  if ('finished' in ending) return withNotes(finishedAnswer(ending.finished), [recorder.settled(ending.finished)])
  // Never an INCOMPLETE record of a run the binary finished: its record is said missing.
  if ('unrecorded' in ending) return withNotes(stoppedAnswer(`review lost the run's last step: ${ending.unrecorded}`), [recorder.missing(ending.unrecorded)])
  sb.phase('Record')
  // A resumed run whose resume ended before the binary named its repository, with none given, has no checkout to key
  // a record to: filing it under the session's would put it in another repository's history.
  const unkeyed = !!o.run && !recorder.keyed()
  if (!unkeyed) await recorder.file({ verdict: 'INCOMPLETE', notRun: ['the craft binary did not finish the run'], runtimeStats: clock.stats() })
  return withNotes(stoppedAnswer(ending.stopped), [unkeyed ? 'No run record was filed: the resumed run\'s repository is unknown (the resume ended before the binary named it, and no repo= was given).' : '', recorder.notes()])
}

/**
 * The service agent that runs the binary, watched for the account's usage limit, and that watch.
 * @param {Sandbox} sb
 */
function serviceOf(sb) {
  const limit = limitWatch()
  const watched = limit.service((p, opts) => sb.agent(p, opts))
  const service = makeDefaultTypeFallback((/** @type {string} */ p, /** @type {Record<string, unknown>} */ opts) => watched(p, opts), sb.log, () => !!limit.seen())
  return { limit, service }
}

/**
 * One service step through `service`: a step that came back with nothing once the usage limit was seen stopped on it.
 * @param {import('./cli-review-record.mjs').Service} service @param {ReturnType<typeof limitWatch>} limit @returns {Serve}
 */
const serveWith = (service, limit) => async (label, title, prompt) => {
  const got = await service.run(prompt, { label, phase: title, schema: RUN_SCHEMA, model: 'haiku', effort: 'low', agentType: SERVICE_AGENT_TYPE })
  return got == null && limit.seen() ? { limit: limit.seen() } : got
}

/**
 * The gate alone (`gateOnly`): the binary got as for a review, then `craft review gate`, its answer the verdict block
 * and the gate's section. It opens no run, so nothing is filed: the parent that asked for it carries the gate in its own
 * record (rust-audit's `gate` dimension; realm @nick/craft, node #150).
 * @param {Sandbox} sb @param {Options} o @param {string} craftVersion @param {Serve} serve @returns {Promise<string>}
 */
async function gateAlone(sb, o, craftVersion, serve) {
  sb.log(`review ${craftVersion}: the mechanical gate alone over ${o.repo || 'the session checkout'}`)
  sb.phase('Start')
  // A given craftBin runs as it is: the gate files nothing, so no plugin root is located for a record.
  const where = o.craftBin !== null && !o.craftRoot ? { bin: o.craftBin } : await binAndRoot(o, craftVersion, serve)
  if ('incomplete' in where) return stoppedAnswer(where.incomplete)
  const read = gateAnswer(await serve('step:gate', 'Start', servicePrompt(gateCommand(where.bin, o))))
  return 'answer' in read ? read.answer : stoppedAnswer(`review's gate did not run: ${read.error}`)
}

/**
 * The runs that are one binary command rather than a review's loop: the gate alone, and a finished run published on its
 * PR; null for a review.
 * @param {Sandbox} sb @param {Options} o @param {string} craftVersion @param {Serve} serve @returns {Promise<string> | null}
 */
function oneStep(sb, o, craftVersion, serve) {
  if (o.gateOnly) return gateAlone(sb, o, craftVersion, serve)
  return o.run && o.comment ? publishAfter(sb, o, craftVersion, serve) : null
}

/**
 * A finished run's findings published on its PR after the fact (`run=` with `comment=true`; realm @nick/craft, node
 * #270): the binary's `craft review comment` sorts and posts them as a run started with comment does when it finishes,
 * and amends the run's record itself, so the driver files nothing — not even when the binary refuses (a run not
 * finished, uncommitted work, a PR head that moved over a defect's line), which it says in its own words.
 * @param {Sandbox} sb @param {Options} o @param {string} craftVersion @param {Serve} serve @returns {Promise<string>}
 */
async function publishAfter(sb, o, craftVersion, serve) {
  sb.log(`review ${craftVersion}: publishing the findings of the finished run ${o.run} on its PR`)
  sb.phase('Start')
  const where = await binAndRoot(o, craftVersion, serve)
  if ('incomplete' in where) return stoppedAnswer(where.incomplete)
  if (where.note) sb.log(where.note)
  const read = resumed(o.run, await serve('step:comment', 'Submit', servicePrompt(`Run exactly this one command, ${SUBMIT_TIMEOUT}:\n\n${commentCommand(where, o)}`)), 'published on its PR')
  if ('error' in read) return 'refused' in read ? `## Verdict\n\n⚠️ Nothing was posted on the PR — ${read.error}${notFinishedHint(o.run, read.error)}` : unknownPublication(o.run, read.error)
  if (!read.step.done) return unknownPublication(o.run, `the binary answered with no finished run: ${JSON.stringify(read.step).slice(0, 200)}`)
  const lost = read.step.filing?.lost ?? []
  for (const line of lost) sb.log(`⚠️ telemetry: ${line}`)
  return withNotes(finishedAnswer(read.step), [telemetryLostSection(lost)])
}

/**
 * `craft review comment` over the run, with the pull request named and the plugin root the record is amended through.
 * @param {{ bin: string, root: string, recordRoot?: string }} where @param {Options} o @returns {string}
 */
function commentCommand(where, o) {
  const recordRoot = where.recordRoot || where.root
  return `${where.bin} review comment --run ${shq(o.run)}${o.pr ? ` --pr ${o.pr}` : ''}${recordRoot ? ` --record-root ${shq(recordRoot)}` : ''}`
}

/**
 * For a run the binary says has not finished — stopped or interrupted —, the two moves in the Workflow's words; '' else.
 * @param {string} run @param {string} error @returns {string}
 */
const notFinishedHint = (run, error) => (/has not finished/.test(error) ? ` — resume it with the Workflow \`craft:review run=${run}\` alone, then publish its findings with \`run=${run} comment=true\`.` : '')

/**
 * A publication whose step was lost — cut off, its agent dead, its output unreadable — after the binary may have posted:
 * no refusal, so the outcome is said unknown, with where to read it.
 * @param {string} run @param {string} error @returns {string}
 */
const unknownPublication = (run, error) => `## Verdict\n\n⚠️ review lost the publication's step (${error}): whether anything was posted on the PR is unknown. Check the PR for comments carrying the craft-finding marker, and the run's state with \`craft review status --run '${run.replace(/'/g, "'\\''")}'\` (its \`filing\` and its report's PR comments section); running run= with comment=true again posts nothing twice.`

/** `answer`, then each note that says something. @param {string} answer @param {string[]} notes @returns {string} */
function withNotes(answer, notes) {
  const said = notes.filter(Boolean).join('\n\n')
  return said ? `${answer}\n\n${said}` : answer
}

/**
 * A refused argument: the logger the only agent, its record the engines' refusal (lib/run-record.mjs, argumentRefusal)
 * with the refusal's class in `notRun`, keyed to the repo given — the session's checkout when `repo` is itself the
 * refused argument, as the engines file theirs — then the answer saying what was refused.
 * @param {Sandbox} sb @param {string} craftVersion @param {Record<string, unknown>} a @param {{ why: string, cls: string }} problem
 * @returns {Promise<string>}
 */
async function refuse(sb, craftVersion, a, { why, cls }) {
  const via = viaName(a['_via']) ?? ''
  const refused = argumentRefusal({ engine: 'review', why, notRun: [cls], craftVersion, outputTokens: sb.budget?.spent() ?? 0, via })
  const service = makeDefaultTypeFallback((/** @type {string} */ p, /** @type {Record<string, unknown>} */ opts) => sb.agent(p, opts), sb.log, () => false)
  const recorder = cliRecorder(sb, { craftVersion, repo: absolutePath(a['repo']) ?? '', depth: 'full', strict: false, via, service })
  sb.phase('Record')
  await recorder.refusal(refused.record)
  const notes = recorder.notes()
  return notes ? `${stoppedAnswer(why)}\n\n${notes}` : stoppedAnswer(why)
}

/** @typedef {Sandbox & { limit: ReturnType<typeof limitWatch>, clock: ReturnType<typeof runClock> }} Watched */

/**
 * The whole loop: start, then rounds of agents and submits until the binary is done. Fails closed: a step that cannot
 * be read ends the run, saying where; a budget throw propagates. A service step that came back with nothing once the
 * usage limit was seen stopped on it.
 * @param {Watched} sb @param {Options} o @param {string} craftVersion
 * @param {import('./cli-review-record.mjs').Service} service @param {Recorder} recorder
 * @returns {Promise<Ending>}
 */
async function drive(sb, o, craftVersion, service, recorder) {
  const serve = serveWith(service, sb.limit)
  sb.log(`review ${craftVersion}: ${o.craftBin ?? `the released binary ${craftVersion}`} over ${o.repo || 'the session checkout'}`)
  sb.phase('Start')
  const where = await binAndRoot(o, craftVersion, serve)
  if ('incomplete' in where) return { stopped: where.incomplete }
  const filedThrough = filedRoot(sb, where, recorder)
  const started = o.run
    ? resumed(o.run, await serve('step:resume', 'Start', submitPrompt(where.bin, o.run, { resume: true, recordRoot: filedThrough }, spentSoFar(sb))))
    : readStep(await serve('step:start', 'Start', startPrompt(o, where, craftVersion)))
  if ('error' in started) return { stopped: stoppedAt(1, started.error, 'refused' in started ? '' : o.run) }
  // A resumed run's record is keyed to the repository the run reviews, which the binary names.
  if (o.run && started.step.repo) recorder.keyTo(started.step.repo)
  sb.clock.observe(started.step)
  recorder.heard(started.step)
  return rounds(sb, where.bin, started.step, serve, recorder)
}

/**
 * The plugin root the run is filed through, handed to the recorder, and why none was located when it was not.
 * @param {Watched} sb @param {{ root: string, recordRoot?: string, note?: string }} where @param {Recorder} recorder
 * @returns {string}
 */
function filedRoot(sb, where, recorder) {
  if (where.note) sb.log(where.note)
  const root = where.recordRoot || where.root
  recorder.at(root)
  return root
}

/**
 * What the binary's telemetry is told on a submit: the task agents dispatched so far and the output tokens spent.
 * @param {Watched} sb @returns {{ agents: number, tokens: number | null }}
 */
const spentSoFar = sb => ({ agents: sb.clock.stats().agents, tokens: sb.budget?.spent() ?? null })

/**
 * Rounds of agents and submits from `first` until the binary is done. Once a task agent ran into the usage limit no
 * other is dispatched, and the submit hands the binary its text, which ends the run. Each step's telemetry write —
 * the binary's checkpoint as one of its phases ends — is heard for the answer's notes.
 * @param {Watched} sb @param {string} bin @param {Step} first @param {Serve} serve @param {Recorder} recorder
 * @returns {Promise<Ending>}
 */
async function rounds(sb, bin, first, serve, recorder) {
  // Only the task agents are counted for the record's runtimeStats.agents: the work the review dispatched, as the
  // engine's agents are its review agents; the service steps that run the binary are not.
  // Counted inside the limit's watch, so a call it answers without dispatching once the limit is seen is not.
  const tasks = taskRunner({ ...sb, agent: sb.limit.tasks(sb.clock.counted(sb.agent)) }, () => !!sb.limit.seen())
  /** @type {{ step: Step } | { error: string }} */
  let read = { step: first }
  for (let round = 1; ; round++) {
    if ('error' in read) return (await recovered(sb, bin, first.run, serve, recorder)) ?? { stopped: stoppedAt(round, read.error, first.run) }
    const step = read.step
    if (step.done) return { finished: step }
    if (round > MAX_ROUNDS) return { stopped: `review gave up after ${MAX_ROUNDS} rounds; the run is in ${step.run}. ${resumeHint(step.run)}` }
    sb.phase('Agents')
    sb.log(`round ${round}: ${step.tasks.length} task(s) — ${step.tasks.map(t => t.label).join(', ')}`)
    // No schema: the binary checks each answer file. A dead agent leaves no file, which the binary asks for again.
    await sb.parallel(step.tasks.map(t => () => tasks.run(t)))
    sb.phase('Submit')
    if (sb.limit.seen()) sb.log(`\u26d4 usage limit reached (${sb.limit.seen()}) — no further review agents are dispatched; the run reports what it has as INCOMPLETE`)
    read = readStep(await serve(`step:submit:${round}`, 'Submit', submitPrompt(bin, step.run, { degraded: tasks.degraded(round), abandoned: tasks.abandoned(), limit: sb.limit.seen() }, spentSoFar(sb))))
    if ('step' in read) {
      sb.clock.observe(read.step)
      recorder.heard(read.step)
    }
  }
}

/**
 * A submit whose output could not be read — garbled, cut by the Bash timeout, its agent dead after the command ran —
 * may still have finished the run and filed its record: the binary is asked what it did before the driver files
 * anything. A run it finished with its record filed, or a stopped one, ends as the binary left it; a finished run
 * whose record did not land has it filed again (`--resume`), and ends as it stands if that cannot be read; null for a
 * run it did not finish, which the driver then files INCOMPLETE; a run it finished without keeping the step to file
 * its record from is said so, and filed by no one.
 * @param {Watched} sb @param {string} bin @param {string} run @param {Serve} serve @param {Recorder} recorder
 * @returns {Promise<{ finished: Finished } | { unrecorded: string } | null>}
 */
async function recovered(sb, bin, run, serve, recorder) {
  const truth = endedOf(await serve('step:status', 'Submit', statusPrompt(bin, run)))
  if (!truth || 'unrecorded' in truth) return truth
  const again = truth.refile ? readStep(await serve('step:refile', 'Submit', submitPrompt(bin, run, { resume: true }, spentSoFar(sb)))) : null
  // A re-file that could not be read leaves the run as the binary left it, its record said missing — never a
  // second, INCOMPLETE record of a run the binary finished.
  const ended = again && 'step' in again && again.step.done ? again.step : truth.finished
  sb.log(`the run's last step could not be read; the binary says it ended: ${ended.verdict}`)
  recorder.heard(ended)
  return { finished: ended }
}

/** The step that asks the binary where the run stands. @param {string} bin @param {string} run @returns {string} */
const statusPrompt = (bin, run) => servicePrompt(`Run exactly this one command:\n\n${bin} review status --run ${shq(run)}`)

