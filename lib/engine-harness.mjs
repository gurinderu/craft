// Runs a whole workflow engine in-process against a scripted fake agent.
//
// Why this exists. `workflows/*.js` are outside ESLint and outside `node --test`: the trio of
// top-level `export` + `await` + `return` is legal only inside the workflow sandbox's wrapper, so
// the scripts cannot be imported. The standing consequence was that every property of the hottest
// code in the repo was pinned — if at all — by matching the SOURCE TEXT, which catches a deletion
// and never catches a defect. Nine review rounds on one branch found five real bugs in that blind
// spot, each in a place the previous round had not looked.
//
// The engines have exactly ONE unmockable dependency: `agent()`. Git, the filesystem, the logger —
// everything external is reached by dispatching an agent to run a shell command. So a fake agent
// that answers by label drives the entire engine, and what it produces (the report, the run record
// it tried to file, the telemetry section) becomes assertable.
//
// `check-workflows.mjs` already reproduces the sandbox wrapper to COMPILE these scripts. This is the
// same wrapper, executed instead of compiled.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findRegions } from './inline-regions.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

export function engineSource(name) {
  return fs.readFileSync(path.join(ROOT, 'workflows', `${name}.js`), 'utf8')
}

// Every engine on disk, DERIVED rather than listed. The distinction is the one this whole file is
// about: a hand-written roster is a memory of which files carry a property, and the memory is what
// goes stale. Twice on this branch a fix reached the engines a list named and missed the ones it did
// not — the shared write path landed in four engines while `rust-review` and `nix-review`, which
// advertise the very same options, kept dropping them.
export function allEngines() {
  return fs.readdirSync(path.join(ROOT, 'workflows'))
    .filter(f => f.endsWith('.js'))
    .map(f => f.replace(/\.js$/, ''))
    .sort()
}

// Derived STRUCTURALLY — by which shared source an engine inlines — rather than by the name of the
// function it happens to call. The difference decides whether the derivation can be escaped: a
// name-based match is defeated by a rename or a differently-named wrapper, and an engine that files
// records through its own `fileRun()` would drop out of every shared record-filing assertion while
// still looking claimed. Inlining `lib/run-logging.mjs` is the thing that MAKES an engine a record
// filer, so that is what is asked.
function inlines(name, source) {
  return findRegions(engineSource(name)).some(r => r.source === source)
}

export function recordFilingEngines() {
  return allEngines().filter(n => inlines(n, 'lib/run-logging.mjs'))
}

export function optionReadingEngines() {
  return allEngines().filter(n => inlines(n, 'lib/workflow-args.mjs'))
}

export const RECORD_FILING_ENGINES = recordFilingEngines()
export const RECORD_FILING_FILES = RECORD_FILING_ENGINES.map(n => `${n}.js`)
export const OPTION_READING_ENGINES = optionReadingEngines()


// A scripted answer: a literal value, or a function of (prompt, opts) for label-collisions that must
// answer differently per call (a checkpoint returning a fresh runDir the second time, say).
function answerFor(script, label, prompt, opts, callIndex) {
  if (!Object.prototype.hasOwnProperty.call(script, label)) return undefined
  const entry = script[label]
  return typeof entry === 'function' ? entry({ prompt, opts, callIndex }) : entry
}

// Labels carry a colon-suffixed discriminator (`scout:rust`, `checkpoint:rust-plan`, `lens:naming`),
// so a script keys on either the exact label or its prefix — the prefix form is what a test wants
// when it does not care which lens answered.
// The key that answered, if any — resolved before the answer so the call can be counted against it.
function keyFor(script, label) {
  if (Object.prototype.hasOwnProperty.call(script, label)) return label
  const colon = String(label ?? '').indexOf(':')
  const prefix = colon > 0 ? String(label).slice(0, colon) : null
  if (prefix && Object.prototype.hasOwnProperty.call(script, prefix)) return prefix
  return Object.prototype.hasOwnProperty.call(script, '*') ? '*' : null
}

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

export async function runEngine(name, { args = {}, script = {}, budgetTotal = 1e9 } = {}) {
  const src = engineSource(name).replace(/^export const meta/m, 'const meta')
  const calls = []
  const phases = []
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
      call.threw = String(err?.message ?? err) || 'died with no message'
      throw err
    }
    return call.result
  }

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
  const parallel = async thunks => Promise.all((thunks || []).map(async t => {
    try {
      return typeof t === 'function' ? await t() : await t
    } catch {
      return null
    }
  }))

  const fn = new AsyncFunction(
    'args', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'budget', 'workflow',
    src,
  )
  const report = await fn(
    args,
    agent,
    parallel,
    // `pipeline` is passed because the sandbox passes it, and nothing more: no engine calls it (the
    // word appears in workflows/*.js only inside prose). A stub with a body would be fidelity nobody
    // exercises and nobody would notice going wrong, so it stays a thing that throws if ever reached.
    () => { throw new Error('pipeline() is not used by any engine — if one now does, give the harness a real stub') },
    title => phases.push(title),
    (...a) => logs.push(a.map(String).join(' ')),
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
    (...argv) => dispatch('workflow',
      { label: 'workflow', key: null, prompt: '', opts: argv[1] ?? {}, argv, result: undefined, threw: 'budget exhausted' },
      () => ({
        call: { label: 'workflow', key: 'workflow', prompt: '', opts: argv[1] ?? {}, argv, result: undefined },
        produce: async () => {
          const answer = Object.prototype.hasOwnProperty.call(script, 'workflow') ? script.workflow : null
          return typeof answer === 'function' ? await answer({ argv }) : answer
        },
      })),
  ).catch(err => {
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
export function filedRecord({ calls }) {
  const call = [...calls].reverse().find(c => /^log-run|^logrun|^log_run/i.test(c.label) || /craft-log-run/.test(c.prompt))
  if (!call) return null
  // The record is the last JSON object in the prompt, introduced by its own heading. Anchoring on
  // the heading rather than on "the last {...}" keeps this from silently picking up an example
  // object if one is ever added to the instructions above it.
  const m = call.prompt.match(/\n(?:RECORD|PAYLOAD):\s*\n([\s\S]+?)\n*$/)
  if (!m) return null
  try {
    return JSON.parse(m[1].trim())
  } catch {
    return null
  }
}
