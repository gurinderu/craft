// Runs a whole workflow engine in-process against a scripted fake agent.
//
// Why this exists. An engine cannot be imported — neither as authored (`src/*.js`) nor as shipped (`workflows/*.js`,
// its bundle): the trio of top-level `export` + `await` + `return` is legal only inside the workflow sandbox's
// wrapper. The standing consequence was that every property of the hottest
// code in the repo was pinned — if at all — by matching the SOURCE TEXT, which catches a deletion
// and never catches a defect. Nine review rounds on one branch found five real bugs in that blind
// spot, each in a place the previous round had not looked.
//
// The engines have exactly ONE unmockable dependency: `agent()`. Git, the filesystem, the logger —
// everything external is reached by dispatching an agent to run a shell command. So a fake agent
// that answers by label drives the entire engine, and what it produces (the report, the run record
// it tried to file, the telemetry section) becomes assertable.
//
// `check-workflows.mjs` already reproduces the sandbox wrapper to COMPILE the shipped scripts. This is the same
// wrapper, executed instead of compiled, around the engine built in memory from src/ and lib/ as they are on disk
// (`builtSource`, below) — the shipped bundle's own text, while check:engines holds workflows/ a fresh build.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import { bundleEngine } from './engine-bundle.mjs'
import { libModulesOf } from './engine-form.mjs'
import { loadTypescript, tscMissingMessage } from './run-tsc.mjs'
import { SANDBOX_ABSENT } from './sandbox-globals.mjs'
import { ledgerFromShards } from './ledger-in-shards.mjs'
import { recordFromParts } from './record-parts-assemble.mjs'

/**
 * @typedef {object} Call
 * @property {string} label
 * @property {string | null} key
 * @property {string} prompt
 * @property {any} opts
 * @property {any[]} [argv]
 * @property {any} result
 * @property {string} [threw]
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

// What the real sandbox does NOT provide (lib/sandbox-globals.mjs) is declared as trailing parameters
// that no call passes, so each is `undefined` inside the body and an engine that reaches for one fails
// here as it would live — with no argument list to keep aligned.
export { SANDBOX_ABSENT }

// The clock and randomness reads the sandbox throws on (they would break resume; the static gate
// refuses them too, lib/engine-clock-rule.mjs): `Date.now()`, `Math.random()`, `Date()` and an argless
// `new Date`. The engine sees these shadows in place of the globals, so a harness run fails where a
// live one would; everything else — `new Date(x)`, `Date.parse`, `instanceof Date`, `Math.max` —
// is the real thing.
/** @param {string} what @returns {never} */
const clockRead = what => { throw new Error(`${what} — the Workflow sandbox throws on reading the clock or randomness`) }
const RealDate = Date
/** @param {...unknown} a @this {unknown} */
function SandboxDate(...a) {
  if (!new.target) clockRead('Date() called without new')
  if (!a.length) clockRead('an argless new Date')
  return Reflect.construct(RealDate, a, new.target)
}
Object.setPrototypeOf(SandboxDate, RealDate)
SandboxDate.prototype = RealDate.prototype
SandboxDate.now = () => clockRead('Date.now()')
const SandboxMath = Object.freeze(Object.assign(Object.create(Math), { random: () => clockRead('Math.random()') }))

const GLOBALS = ['args', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'budget', 'workflow']

/**
 * An engine body as the sandbox runs it: its eight globals as parameters (passed in this order), the
 * absent ones shadowed as undefined, `Date` and `Math` shadowed by the throwing stand-ins.
 * What the engine returns is whatever it builds (report text, or adversarial-review's object), read by
 * tests field by field — as untyped as the AsyncFunction this wraps always returned.
 * @param {string} src @returns {(...given: unknown[]) => Promise<any>}
 */
export function sandboxFunction(src) {
  const fn = new AsyncFunction(...GLOBALS, ...SANDBOX_ABSENT, 'Date', 'Math', src)
  return (...given) => fn(...GLOBALS.map((_, i) => given[i]), ...SANDBOX_ABSENT.map(() => undefined), SandboxDate, SandboxMath)
}

// An engine as authored (src/, comments in place): what the rosters and the source-text pins read.
/** @param {string} name @returns {string} */
export function engineSource(name) {
  return authoredText(`src/${name}.js`)
}

// The code an engine is built from, as text: its source, then every lib/ module it imports (realm @nick/craft,
// #210) — whole, before tree-shaking: what an absence pin (no clock, no prose recipe) reads.
/** @param {string} name @returns {string} */
export function engineCode(name) {
  const mods = libModulesOf(ROOT, `src/${name}.js`).map(m => authoredText(m))
  return [engineSource(name), ...mods].join('\n')
}

// Stryker's in-place run (stryker.config.mjs: `inPlace`, `tempDirName`) rewrites the files it reads and keeps each
// original under <tempDirName>/backup-<id>/ until it restores them: every lib/ module it mutates becomes its mutants,
// switched at runtime, and every other script, workflows/ included, gains a leading `// @ts-nocheck` line. A pin on a
// file's text, or on a line of it, reads the original: the rewrite is one text for every mutant, so a pin on it tells
// none of them apart, and its wrappers and the added line break pins on the code's shape and its places. The backup
// layout, the stryNS_ preamble and where the @ts-nocheck line goes are Stryker 10's own (realm @nick/craft, node #162).
export const STRYKER_TEMP_DIR = '.stryker-tmp'
const STRYKER_PREAMBLE = /\bfunction stryNS_[0-9a-f]+\(\) \{/
const STRYKER_NOCHECK = '// @ts-nocheck\n'
const LEADING_BLOCK = /^\s*\/\*.*?\*\//s

// The text Stryker makes of an unmutated script: its line after a shebang line or a leading block comment, else first.
/** @param {string} code @returns {string} */
function withNoCheck(code) {
  if (code.startsWith('#')) {
    const nl = code.indexOf('\n')
    return nl > 0 ? `${code.slice(0, nl)}\n${STRYKER_NOCHECK}${code.slice(nl + 1)}` : code
  }
  const lead = LEADING_BLOCK.exec(code)?.[0]
  return lead === undefined ? STRYKER_NOCHECK + code : `${lead}\n${STRYKER_NOCHECK}${code.slice(lead.length)}`
}

/** A file's text as written, `rel` relative to `root`. @param {string} rel @param {string} [root] @returns {string} */
export function authoredText(rel, root = ROOT) {
  const text = fs.readFileSync(path.join(root, rel), 'utf8')
  const mutated = STRYKER_PREAMBLE.test(text)
  if (!mutated && !text.includes(STRYKER_NOCHECK)) return text
  const tmp = path.join(root, STRYKER_TEMP_DIR)
  const backups = (fs.existsSync(tmp) ? fs.readdirSync(tmp) : [])
    .filter(d => d.startsWith('backup-') && fs.existsSync(path.join(tmp, d, rel)))
    .map(d => ({ file: path.join(tmp, d, rel), at: fs.statSync(path.join(tmp, d)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
  // A killed run leaves its backup behind; the newest is this run's.
  const original = backups[0] && fs.readFileSync(backups[0].file, 'utf8')
  if (original !== undefined && text === withNoCheck(original)) return original
  if (!mutated) return text   // a @ts-nocheck that Stryker did not add is the file's own
  if (original === undefined) throw new Error(`${rel} is instrumented by Stryker and no backup of it is under ${STRYKER_TEMP_DIR}/backup-*: its text as written is unknown`)
  return original
}

// An engine as it ships (workflows/, generated by lib/build-engines.mjs): what a presence pin on the shipped text
// reads — a bundle carries only what it keeps, so a string elsewhere in a lib/ module it reaches proves nothing
// about the run. An absence pin reads `engineCode`, where wider is stricter. That workflows/ is a fresh build of
// src/ is check:engines' to hold, not this file's.
/** @param {string} name @returns {string} */
export function shippedSource(name) {
  return authoredText(`workflows/${name}.js`)
}

// An engine as `runEngine` runs it: built from `root`/src and `root`/lib as they are on disk now, by the build's own
// bundling step (lib/engine-bundle.mjs) with no source map, in memory — nothing is written. Not workflows/: a
// changed lib/ module, a mutant Stryker plants in place among them, must change what the engine tests execute.
// Built once per process for each engine and content of its source and lib/ closure, so a test file running an
// engine many times bundles it once and an edited module is never served from a stale build. Unchecked: the
// shipped text's checks are check:engines' (lib/build-engines.mjs), and modules Stryker instruments each declare
// the same helper names, which esbuild renames apart — a name check would refuse every mutant's build.
/** @type {Map<string, Promise<string>>} */
const builds = new Map()
/** @type {import('./run-tsc.mjs').TypeScript | null} */
let typescript = null

/** @param {string} name @param {string} [root] @returns {Promise<string>} */
export function builtSource(name, root = ROOT) {
  const file = `src/${name}.js`
  /** @param {string} rel */
  const read = rel => fs.readFileSync(path.join(root, rel), 'utf8')
  const source = read(file)
  const hash = crypto.createHash('sha256').update(source)
  for (const m of libModulesOf(root, file)) hash.update(`\0${m}\0`).update(read(m))
  const key = `${root}\0${name}\0${hash.digest('hex')}`
  let built = builds.get(key)
  if (!built) {
    typescript ??= loadTypescript(ROOT)
    if (!typescript) throw new Error(tscMissingMessage(ROOT))
    built = bundleEngine({ esbuild, ts: typescript, root, file, source, maps: false, checked: false }).then(b => b.js)
    builds.set(key, built)
  }
  return built
}

// Every engine on disk, DERIVED rather than listed. The distinction is the one this whole file is
// about: a hand-written roster is a memory of which files carry a property, and the memory is what
// goes stale. Twice on this branch a fix reached the engines a list named and missed the ones it did
// not — the shared write path landed in four engines while `rust-review` and `nix-review`, which
// advertise the very same options, kept dropping them.
export function allEngines() {
  return fs.readdirSync(path.join(ROOT, 'src'))
    .filter(f => f.endsWith('.js'))
    .map(f => f.replace(/\.js$/, ''))
    .sort()
}

// Derived STRUCTURALLY — by which shared source an engine imports — rather than by the name of the
// function it happens to call. The difference decides whether the derivation can be escaped: a
// name-based match is defeated by a rename or a differently-named wrapper, and an engine that files
// records through its own `fileRun()` would drop out of every shared record-filing assertion while
// still looking claimed. Importing `lib/run-logging.mjs` — directly or through another lib/ module — is the
// thing that MAKES an engine a record filer, so that is what is asked.
/** @param {string} name @param {string} source @returns {boolean} */
function imports(name, source) {
  return libModulesOf(ROOT, `src/${name}.js`).includes(source)
}

export function recordFilingEngines() {
  return allEngines().filter(n => imports(n, 'lib/run-logging.mjs'))
}

export function optionReadingEngines() {
  return allEngines().filter(n => imports(n, 'lib/workflow-args.mjs'))
}

export const RECORD_FILING_ENGINES = recordFilingEngines()
export const RECORD_FILING_FILES = RECORD_FILING_ENGINES.map(n => `${n}.js`)
export const OPTION_READING_ENGINES = optionReadingEngines()


// A scripted answer: a literal value, or a function of (prompt, opts) for label-collisions that must
// answer differently per call (a checkpoint returning a fresh runDir the second time, say).
/** @param {Record<string, any>} script @param {string} label @param {unknown} prompt @param {any} opts @param {number} callIndex @returns {any} */
function answerFor(script, label, prompt, opts, callIndex) {
  if (!Object.prototype.hasOwnProperty.call(script, label)) return undefined
  const entry = script[label]
  return typeof entry === 'function' ? entry({ prompt, opts, callIndex }) : entry
}

// Labels carry a colon-suffixed discriminator (`scout:rust`, `checkpoint:rust-plan`, `lens:naming`),
// so a script keys on either the exact label or its prefix — the prefix form is what a test wants
// when it does not care which lens answered.
// The key that answered, if any — resolved before the answer so the call can be counted against it.
/** @param {Record<string, any>} script @param {string} label @returns {string | null} */
function keyFor(script, label) {
  if (Object.prototype.hasOwnProperty.call(script, label)) return label
  const colon = String(label ?? '').indexOf(':')
  const prefix = colon > 0 ? String(label).slice(0, colon) : null
  if (prefix && Object.prototype.hasOwnProperty.call(script, prefix)) return prefix
  return Object.prototype.hasOwnProperty.call(script, '*') ? '*' : null
}

/** @param {unknown} report @returns {string} */
function reportText(report) {
  if (typeof report === 'string') return report
  if (!report || typeof report !== 'object') return String(report ?? '')
  return JSON.stringify(report, null, 1)
}

// What one DISPATCHED call costs of the run's budget — agents and nested workflows alike, and
// whether the scripted answer resolves or throws: a live call burns tokens before it dies, so a
// death spends like an answer and refunds nothing; only a REFUSED dispatch (the budget gate) spends
// nothing. The model is one synchronous check+spend+record step at dispatch on BOTH surfaces, so
// the trail order is the dispatch order and `spent` is always `non-refused dispatches × CALL_SPEND`.
// Exported because exhaustion tests calibrate their wall as `index × CALL_SPEND`: a copy of the
// number in a test file would not move when this does, and the wall would land on the wrong call
// with a failure message blaming the calibration instead of naming the constant that drifted.
export const CALL_SPEND = 1000

/**
 * Run one engine end to end.
 *
 * `script` maps an agent label (or its `foo:` prefix, or `*`) to the value that agent returns. A
 * label with no entry returns `null` — a DEAD agent, which is the single most important case to be
 * able to script: an engine that renders a dead agent as a clean result is the defect class this
 * repo keeps hitting, and it is unreachable from a source-text assertion.
 *
 * Returns the engine's own return value (`report`) plus everything it did on the way: which agents
 * it dispatched with what prompt, which phases it entered, what it logged. The prompts matter as
 * much as the report — a correct helper called with the wrong argument is the other recurring
 * defect, and `calls` is where that becomes visible.
 */
/**
 * `root` is the tree the engine is built from (`builtSource`), the checkout unless a test builds a copy.
 * @param {string} name @param {{ args?: any, script?: Record<string, any>, budgetTotal?: number, root?: string }} [opts]
 */
export async function runEngine(name, { args = {}, script = {}, budgetTotal = 1e9, root = ROOT } = {}) {
  const src = (await builtSource(name, root)).replace(/^export const meta/m, 'const meta')
  /** @type {Call[]} */
  const calls = []
  /** @type {string[]} */
  const phases = []
  /** @type {string[]} */
  const logs = []
  let spent = 0

  // `callIndex` counts calls answered by the SAME script key, not by the same label. The difference
  // is not pedantic: a script keyed on `checkpoint` answers `checkpoint:rust-plan` and
  // `checkpoint:rust-lenses`, and counting per-label hands BOTH of them index 0 — so a script that
  // means "return a different directory the second time" silently returns the first answer twice and
  // the test passes against a defect it was written to catch. Found exactly that way.
  const keyCounts = new Map()

  // The ONE dispatch gate, shared by both surfaces. It existed as two hand-maintained copies inside
  // this function — agent() and the workflow stub, bound to each other only by comments — and the
  // copy is what drifted, twice: agent() was gated while workflow() was not (so the one surface a
  // nesting engine fans out through could never run out), and agent() evaluated its answer without
  // awaiting it while workflow() awaited (so an async scripted rejection left `threw` unset and
  // parked the raw Promise in `result` — a completed-looking call for the dispatch that killed the
  // run, on one surface only). One gate makes that asymmetry class unrepresentable.
  //
  // The model, at CALL_SPEND: check + spend + record are ONE synchronous step at dispatch, and only
  // a REFUSED dispatch (the wall) spends nothing and consults no script — a dispatched call spends
  // and is recorded whether its answer resolves or throws, because a live call burns tokens before
  // it dies and a death refunds nothing. The record is pushed BEFORE the answer is awaited: made
  // after, the dying dispatch was the one entry the trail did not contain (err.calls located the
  // death at the previous call), a concurrent answered call landed after its siblings so the trail
  // order was not the dispatch order the wall arithmetic reads, and a spend deferred past the await
  // let a sibling slip between gate and spend so the wall landed one call late — all three measured
  // while the two copies were being kept in step by hand.
  //
  // `threw` is never falsy: every trail consumer filters by truthiness, so the '' that
  // `String(err?.message ?? err)` yields for `new Error('')` would read as a live dispatch.
  /** @param {string} kind @param {Call} refusal @param {() => { call: Call, produce: () => Promise<any> }} open */
  const dispatch = async (kind, refusal, open) => {
    if (spent >= budgetTotal) {
      calls.push(refusal)
      throw new Error(`${kind} budget exhausted (spent ${spent} of ${budgetTotal})`)
    }
    const { call, produce } = open()
    spent += CALL_SPEND
    calls.push(call)
    try {
      call.result = await produce()
    } catch (err) {
      call.threw = String(/** @type {{ message?: unknown } | null | undefined} */ (err)?.message ?? err) || 'died with no message'
      throw err
    }
    return call.result
  }

  /** @param {unknown} prompt @param {{ label?: string }} [opts] */
  const agent = (prompt, opts = {}) => {
    const label = opts.label ?? ''
    // The sandbox's other death, reproduced: agent() resolves null for an API error or a skip, and
    // THROWS in exactly one case — the run's budget is exhausted ("Budget-exceeded THROWS and is
    // deliberately not caught", the resilient-agent-call comment in review.js; parallel() turns the
    // throwing thunk into null). A stub that could never run out kept every
    // INCOMPLETE-by-exhaustion branch unreachable from a test. The refused dispatch is still
    // recorded — the engine DID dispatch it, and which call hit the wall is exactly what a test
    // over this mode asserts on — but it answers no script key, counts no callIndex and spends
    // nothing: a refused call produces no output tokens.
    return dispatch('agent',
      { label, key: null, prompt: String(prompt ?? ''), opts, result: undefined, threw: 'budget exhausted' },
      () => {
        const key = keyFor(script, label)
        const callIndex = key === null ? 0 : (keyCounts.get(key) ?? 0)
        if (key !== null) keyCounts.set(key, callIndex + 1)
        return {
          call: { label, key, prompt: String(prompt ?? ''), opts, result: undefined },
          produce: async () => {
            const value = key === null ? undefined : await answerFor(script, key, prompt, opts, callIndex)
            return value === undefined ? null : value
          },
        }
      })
  }

  // The sandbox hands thunks to `parallel`, not promises: the engine builds `() => agent(...)` so
  // nothing is dispatched until the runner decides to. Keep that shape — awaiting an array of
  // already-started promises would hide an engine that dispatches eagerly.
  //
  // A THROWING thunk becomes `null`, and that is not a convenience: it is the sandbox's documented
  // behaviour (see the comment at the `ragent` wrapper in review.js, and the `.filter(Boolean)` in
  // rust-audit that depends on it). A stub that rejected instead would make "the agent threw" — one
  // of the two halves of the dead-agent class this harness exists to make executable — unreachable,
  // and would present itself as an engine defect rather than a harness one.
  /** @param {any[] | null | undefined} thunks */
  const parallel = async thunks => Promise.all((thunks || []).map(async (/** @type {any} */ t) => {
    try {
      return typeof t === 'function' ? await t() : await t
    } catch {
      return null
    }
  }))

  const fn = sandboxFunction(src)
  const report = await fn(
    args,
    agent,
    parallel,
    // `pipeline` is passed because the sandbox passes it, and nothing more: no engine calls it (the
    // word appears in workflows/*.js only inside prose). A stub with a body would be fidelity nobody
    // exercises and nobody would notice going wrong, so it stays a thing that throws if ever reached.
    () => { throw new Error('pipeline() is not used by any engine — if one now does, give the harness a real stub') },
    (/** @type {string} */ title) => phases.push(title),
    (/** @type {any[]} */ ...a) => logs.push(a.map(String).join(' ')),
    { total: budgetTotal, spent: () => spent, remaining: () => budgetTotal - spent },
    // `workflow()` dispatches a NESTED engine and is awaited/`.then`-ed by its caller, so the stub
    // must be thenable: returning undefined crashes rust-audit before it reaches anything worth
    // asserting. Nested runs answer null by default — a nested engine that died, the case a caller
    // is most likely to render as clean — and the dispatch is RECORDED, because what gets threaded
    // into a nested run (base, path, languages, craftRoot) is otherwise invisible to every
    // assertion, and craftRoot is exactly the argument a live defect turns on.
    // Called as `workflow(name, args)` — BOTH are recorded. Keeping only the first argument was a
    // silent hole of exactly the kind this file exists to close: the dispatch showed up in `calls`,
    // an assertion over it looked meaningful, and the payload it was actually asserting about was
    // not there.
    // Gated THROUGH the same gate as agent(), not by a copy of it: a nested run is dispatched
    // work, so an exhausted budget refuses it and a dispatched one spends like any other call.
    // Without the gate, the one dispatch surface rust-audit nests through could never run out, and
    // an exhaustion test over a nesting engine would lean on a stub refusing nothing. The callers'
    // own `.catch(() => null)` turns the throw into a NOT-RUN entry, same as a nested engine that died.
    (/** @type {any[]} */ ...argv) => dispatch('workflow',
      { label: 'workflow', key: null, prompt: '', opts: argv[1] ?? {}, argv, result: undefined, threw: 'budget exhausted' },
      () => ({
        call: { label: 'workflow', key: 'workflow', prompt: '', opts: argv[1] ?? {}, argv, result: undefined },
        produce: async () => {
          const answer = Object.prototype.hasOwnProperty.call(script, 'workflow') ? script['workflow'] : null
          return typeof answer === 'function' ? await answer({ argv }) : answer
        },
      })),
  ).catch((/** @type {any} */ err) => {
    // An engine that dies mid-run (a budget throw reaching a dispatch nothing catches) rejects this
    // whole call — by design: the sandbox kills an exhausted run the same way. The trail up to the
    // death still matters to a test — WHICH dispatches were refused before the engine fell over is
    // exactly what an exhaustion test asserts — so the escaping error carries `calls` with it.
    // Guarded: a scripted function can throw anything, a frozen error included, and in strict mode
    // the bare assignment would then throw a TypeError that REPLACES the engine's actual death on
    // the very path built to preserve it. An unwritable error keeps its death; only the trail is lost.
    // Functions accept properties like objects do, so a thrown function carries the trail too. A
    // PRIMITIVE throw (`throw 'reason'`) is the documented floor of this road: a primitive has
    // nowhere to carry a trail, and wrapping it in an Error would replace the death with
    // bookkeeping — the exact substitution the frozen-error guard exists to refuse — so it escapes
    // bare and a consumer reading `e.calls || []` sees an empty trail.
    if ((typeof err === 'object' || typeof err === 'function') && err !== null) {
      try { err.calls = calls } catch { /* unwritable error — keep the death, lose the trail */ }
    }
    throw err
  })
  // `review`, `rust-audit` and `triage-findings` return report markdown; `adversarial-review`
  // returns a structured object and its telemetry lives in `notRun`. Tests that assert a shared
  // property need one surface to assert on, so both are flattened to text here — losing nothing,
  // since every field of the object is a string or a list of them.
  return { report: reportText(report), reportValue: report, calls, phases, logs }
}

// The record an engine TRIED to file, recovered from the logger prompt it dispatched. The engine
// never touches the filesystem itself — it hands a model a heredoc — so this is the only place the
// outgoing record is observable, and it is exactly where a field can be wrong while every unit test
// over `lib/` stays green.
// As FILED, that is after finalize: a record that left its ledger to its shards gets it back from the
// shard checkpoints the harness answered as landed, through the same step finalize takes (realm
// @nick/craft, node #245). `sentRecord` is the record as the logger prompt carries it.
// A record sent in parts (realm @nick/craft, node #396) is put back from the part checkpoints the same way:
// `filedRecord` from those answered as landed, `sentRecord` from every part the engine sent.
/** @param {{ calls: Call[] }} run @returns {any} */
export function filedRecord(run) {
  const header = loggerPayload(run)
  if (!header || typeof header !== 'object') return header
  const landed = run.calls.filter(c => /^checkpoint:/.test(c.label) && c.result?.runDir).map(c => promptJson(c.prompt)).filter(Boolean)
  return ledgerFromShards(recordFromParts(header, landed, '').record, landed, '').record
}

/** @param {{ calls: Call[] }} run @returns {any} */
export function sentRecord(run) {
  const header = loggerPayload(run)
  if (!header || typeof header !== 'object') return header
  return recordFromParts(header, run.calls.filter(c => /^checkpoint:record-/.test(c.label)).map(c => promptJson(c.prompt)).filter(Boolean), '').record
}

// The payload of the last logger call: the record, or the header of one sent in parts.
/** @param {{ calls: Call[] }} run @returns {any} */
function loggerPayload({ calls }) {
  const call = [...calls].reverse().find(c => /^log-run|^logrun|^log_run/i.test(c.label) || /craft-log-run/.test(c.prompt))
  return call ? promptJson(call.prompt) : null
}

/** @param {string} prompt @returns {any} */
function promptJson(prompt) {
  // The record is the last JSON object in the prompt, introduced by its own heading. Anchoring on
  // the heading rather than on "the last {...}" keeps this from silently picking up an example
  // object if one is ever added to the instructions above it.
  const m = prompt.match(/\n(?:RECORD|PAYLOAD):\s*\n([\s\S]+?)\n*$/)
  if (!m) return null
  try {
    return JSON.parse(/** @type {string} */ (m[1]).trim())
  } catch {
    return null
  }
}

/**
 * A scripted match judge (`decision-match`, realm @nick/craft, node #230) that calls every pair it is
 * shown the same defect — for tests whose records match by title and are not about the judge.
 * @param {{ prompt: string }} call @returns {{ verdicts: { pair: number, same: boolean, why: string }[] }}
 */
export function judgeAllSame({ prompt }) {
  const block = prompt.match(/^\[\{"pair".*\]$/m)?.[0]
  const pairs = /** @type {{ pair: number }[]} */ (block ? JSON.parse(block) : [])
  return { verdicts: pairs.map(p => ({ pair: p.pair, same: true, why: 'the same defect' })) }
}
