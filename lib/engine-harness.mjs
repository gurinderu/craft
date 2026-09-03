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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

// Every engine that files a run record. Tests that assert a shared property iterate THIS list rather
// than naming one engine: a rule living in four files and tested in one is how the telemetry marker
// came to be fixed in `adversarial-review` and nowhere else, with every gate green.
export const RECORD_FILING_ENGINES = ['review', 'adversarial-review', 'rust-audit', 'triage-findings']

export function engineSource(name) {
  return fs.readFileSync(path.join(ROOT, 'workflows', `${name}.js`), 'utf8')
}

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
  const agent = async (prompt, opts = {}) => {
    const label = opts.label ?? ''
    const key = keyFor(script, label)
    const callIndex = key === null ? 0 : (keyCounts.get(key) ?? 0)
    if (key !== null) keyCounts.set(key, callIndex + 1)
    const value = key === null ? undefined : answerFor(script, key, prompt, opts, callIndex)
    const result = value === undefined ? null : value
    calls.push({ label, key, prompt: String(prompt ?? ''), opts, result })
    spent += 1000
    return result
  }

  // The sandbox hands thunks to `parallel`, not promises: the engine builds `() => agent(...)` so
  // nothing is dispatched until the runner decides to. Keep that shape — awaiting an array of
  // already-started promises would hide an engine that dispatches eagerly.
  const parallel = async thunks => Promise.all((thunks || []).map(t => (typeof t === 'function' ? t() : t)))
  const pipeline = async (items, first, second) => {
    const out = []
    for (const item of items || []) {
      const a = await (typeof first === 'function' ? first(item) : null)
      out.push(second ? await second(a) : a)
    }
    return out
  }

  const fn = new AsyncFunction(
    'args', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'budget', 'workflow',
    src,
  )
  const report = await fn(
    args,
    agent,
    parallel,
    pipeline,
    title => phases.push(title),
    (...a) => logs.push(a.map(String).join(' ')),
    { total: budgetTotal, spent: () => spent, remaining: () => budgetTotal - spent },
    // `workflow()` dispatches a NESTED engine and is awaited/`.then`-ed by its caller, so the stub
    // must be thenable: returning undefined crashes rust-audit before it reaches anything worth
    // asserting. Nested runs answer null — a nested engine that died — which is the case a caller
    // is most likely to render as clean.
    async () => null,
  )
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
