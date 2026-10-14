export const meta = {
  name: 'triage-findings',
  description: 'Triage review findings (craft agents + GitHub PR comments) into one ordered, validated fix plan — no edits',
  whenToUse: 'After a review or rust-audit produces many findings, or a PR has many inline comments, and you want them validated against the code, deduped, conflict-checked, and turned into an ordered fix plan. It reads ONLY the checkout the session runs in: there is no `repo` argument, and passing one is refused with nothing run (use `craft:review` with repo=, or start a session inside that repository).',
  phases: [
    { title: 'Gather', detail: 'pull raw findings from the requested sources (rust-audit report, reviewer verdict, GitHub PR threads)' },
    { title: 'Validate', detail: 'judge each finding against the code at a pinned ref: accept / reject / defer / needs-decision' },
    { title: 'Plan', detail: 'dedup, detect conflicts, group by file, order, render a writing-plans-format fix plan + triage ledger' },
  ],
}

// Locator args (not payload): pr (GitHub PR number), report (path to a rust-audit report or saved
// verdict), base (ref to pin validation against), priorLedger (array of prior {stable_id, verdict,
// reason} for idempotent re-runs). At least one of pr/report must be given.
// `args` may arrive as a parsed object or as a JSON string depending on the harness — normalize.
// ---- args ----
// Three plausible spellings arrive here — a real object, a JSON string, and the `key=value` form the
// skill's own invocation line advertises — and only the first used to work. The other two fell
// through every `typeof args === 'object'` guard, so every option reverted to its default and the
// run reviewed whatever the session was sitting in, then reported a confident verdict for a diff
// nobody asked about. Shared with every other engine (lib/workflow-args.mjs, inlined below).
// >>> craft-inline lib/workflow-args.mjs applyOption OBJECT_ONLY_OPTIONS parseOptions normalizeJsonArgs normalizeKeyValueArgs normalizeArgs
/**
 * @param {RegExpExecArray} m
 * @param {Record<string, unknown>} out
 * @param {string[]} ignored
 * @returns {number}
 */
function applyOption(m, out, ignored) {
  /** @param {string} k */
  const banned = k => k === '__proto__' || k === 'constructor' || k === 'prototype'
  if (m[7]) {
    if (banned(m[7])) { ignored.push(m[7]); return 0 }
    out[m[7]] = true
    return 1
  }
  const key = /** @type {string} */ (m[2])
  if (banned(key)) { ignored.push(key); return 0 }
  const quoted = m[4] ?? m[5]
  if (quoted !== undefined) { out[key] = quoted; return 1 }
  try {
    out[key] = JSON.parse(/** @type {string} */ (m[3]))
  } catch {
    out[key] = /** @type {string} */ (m[3])
  }
  return 1
}

const OBJECT_ONLY_OPTIONS = ['priorDecisions']

/**
 * @param {string} text
 * @returns {{ options: Record<string, unknown>, pairs: number, ignored: string[], cut: string }}
 */
function parseOptions(text) {
  const pair = /(--?)?(\w[\w-]*)=("([^"]*)"|'([^']*)'|\S+)|(--)(\w[\w-]*)/g
  /** @type {Record<string, unknown>} */
  const out = {}
  let pairs = 0
  /** @type {string[]} */
  const ignored = []
  let m
  let cursor = 0
  while ((m = pair.exec(text)) !== null) {
    const gap = text.slice(cursor, m.index).trim()
    if (gap) ignored.push(...gap.split(/\s+/))
    const key = String(m[2] ?? m[7])
    if (OBJECT_ONLY_OPTIONS.includes(key)) { out[key] = text.slice(m.index); return { options: out, pairs: pairs + 1, ignored, cut: key } }
    cursor = pair.lastIndex
    pairs += applyOption(m, out, ignored)
  }
  const tail = text.slice(cursor).trim()
  if (tail) ignored.push(...tail.split(/\s+/))
  return { options: out, pairs, ignored, cut: '' }
}

/**
 * @param {string} text
 * @param {(msg: string) => void} warn
 * @returns {Record<string, unknown>}
 */
function normalizeJsonArgs(text, warn) {
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      warn('⚠️ args arrived as a JSON string, not an object — parsed it; pass a real object to avoid this')
      return parsed
    }
    warn('⚠️ args arrived as a non-object JSON value — ALL options ignored, running with defaults')
    return {}
  } catch (e) {
    warn(`⚠️ args arrived as a string that looks like JSON but is not (${String((e && /** @type {{ message?: unknown }} */ (e).message) || e).slice(0, 60)}) — ALL options ignored, running with defaults`)
    return {}
  }
}

/**
 * @param {string} text
 * @param {(msg: string) => void} warn
 * @returns {Record<string, unknown>}
 */
function normalizeKeyValueArgs(text, warn) {
  const { options, pairs, ignored, cut } = parseOptions(text)
  if (cut) warn(`⚠️ ${cut} arrived in the key=value string — it and everything after it were not read as options (its value cannot be delimited there); pass args as an object`)
  if (pairs) {
    warn('⚠️ args arrived as a key=value string — parsed it; pass a real object to avoid this')
    if (ignored.length) {
      warn(`⚠️ ignored ${ignored.length} word(s) in args that are not options (${ignored.slice(0, 6).join(' ')}) — quote a value that contains spaces`)
    }
    return options
  }
  warn(`⚠️ args arrived as an unrecognized string (${text.slice(0, 40)}) — ALL options ignored, running with defaults`)
  return {}
}

/**
 * Normalize whatever arrived into an options object.
 *
 * `warn` is called with one human sentence per degradation and must not throw — engines pass their
 * `log`. It is called on the recovered forms too, deliberately: a run that silently accepted a
 * shape it had to repair teaches the next caller nothing.
 *
 * @param {unknown} args
 * @param {(msg: string) => void} [warn]
 * @returns {Record<string, unknown>}
 */
function normalizeArgs(args, warn = () => {}) {
  if (args && typeof args === 'object' && !Array.isArray(args)) return /** @type {Record<string, unknown>} */ (args)
  if (typeof args !== 'string' || !args.trim()) return {}
  const text = args.trim()
  if (text.startsWith('[') || text.startsWith('"')) {
    warn(`⚠️ args arrived as a JSON value that is not an object (${text.slice(0, 40)}) — ALL options ignored, running with defaults`)
    return {}
  }
  if (text.startsWith('{')) return normalizeJsonArgs(text, warn)
  return normalizeKeyValueArgs(text, warn)
}
// <<< craft-inline
const A = normalizeArgs(args, log)

// One arg path, not two. The second one used to re-parse the raw string after normalizeArgs had
// already refused it, so a value reported as "ALL options ignored" was quietly reinstated a line
// later — a loud drop undone in silence, which is worse than either behaviour alone.
const argv = A

/** A text argument: its string form when given (truthy), else ''. @param {string} key @returns {string} */
function textArg(key) {
  return argv[key] ? String(argv[key]) : ''
}

const pr = textArg('pr')
const report = textArg('report')
const base = textArg('base')
/** @type {unknown[]} */
const priorLedger = Array.isArray(argv['priorLedger']) ? /** @type {unknown[]} */ (argv['priorLedger']) : []
// Where craft itself lives, so the logger can find lib/craft-log-run.mjs. It selects NO repository:
// this engine has no `repo` argument (see the refusal above) and always triages the checkout the
// session runs in. As an installed plugin CLAUDE_PLUGIN_ROOT is
// set for us; launched by scriptPath from a checkout it is NOT, and the fallback would resolve
// against the triaged repo — where the script is not. Pass craftRoot then.
const craftRootArg = textArg('craftRoot')

const RAW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['source', 'findings'],
  properties: {
    source: { type: 'string', description: 'rust-audit | rust-reviewer | github-pr' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'title', 'location', 'detail', 'proposed_fix', 'thread_id'],
        properties: {
          severity: { type: 'string', description: 'Critical | High | Medium | Low | Info' },
          title: { type: 'string' },
          location: { type: 'string', description: 'file:line, crate/module, PR-level, or empty if none' },
          detail: { type: 'string', description: 'why it is a problem' },
          proposed_fix: { type: 'string', description: 'fix direction from the source, empty if none' },
          thread_id: { type: 'string', description: 'GitHub review thread id, empty if not from a PR' },
        },
      },
    },
  },
}

const VALIDATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['stable_id', 'verdict', 'reason', 'fix_pointer', 'premise_checked'],
  properties: {
    stable_id: { type: 'string', description: 'composite identity: source::location::title' },
    verdict: { type: 'string', description: 'accept | reject | defer | needs-decision' },
    reason: { type: 'string', description: 'one line justifying the verdict against the code' },
    premise_checked: { type: 'string', description: 'the file:line you actually opened to settle the verdict\'s load-bearing premise when it lives outside the cited location — a dependency\'s behaviour, reachability, what a caller or sibling does. Applies to reject exactly as much as to accept. Empty string only when the cited location alone settled it' },
    fix_pointer: { type: 'string', description: 'owning craft skill + one-line fix direction; empty unless accept' },
  },
}

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['plan_markdown', 'ledger', 'summary'],
  properties: {
    plan_markdown: { type: 'string', description: 'the fix plan in checkbox-task markdown format (accepted findings only)' },
    ledger: {
      type: 'array',
      description: 'every finding keyed by stable_id with its final verdict',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['stable_id', 'verdict', 'reason'],
        properties: {
          stable_id: { type: 'string' },
          verdict: { type: 'string', description: 'accept | reject | defer | needs-decision | conflict' },
          reason: { type: 'string' },
        },
      },
    },
    summary: { type: 'string', description: 'human-readable rundown of reject/defer/needs-decision/conflict' },
  },
}

// The shapes the three schemas above promise. `agent()` returns them only when it ran: a skipped
// or dead agent yields `null`, so every call site casts to `T | null` and handles the null.
/** @typedef {{ severity: string, title: string, location: string, detail: string, proposed_fix: string, thread_id: string }} RawFinding */
/** @typedef {{ source: string, findings: RawFinding[] }} RawResult */
/** @typedef {RawFinding & { source: string }} SourcedFinding */
/** @typedef {{ stable_id: string, verdict: string, reason: string, fix_pointer: string, premise_checked: string }} Validation */
/** @typedef {{ stable_id: string, verdict: string, reason: string }} LedgerEntry */
/** @typedef {{ plan_markdown: string, ledger: LedgerEntry[], summary: string }} PlanResult */
// What this script adds to the plan before returning it — not part of PLAN_SCHEMA.
/** @typedef {PlanResult & { notRun?: string[], telemetryLost?: string[] }} TriagePlan */

// The craft release that produced a run. Recorded on the run record and index line so an
// aggregate can be filtered to ONE engine version: without it, runs from every rubric the store
// has ever seen blend together. MUST match `.claude-plugin/plugin.json` — `lib/check-workflows.mjs`
// fails the build if it drifts. Kept OUTSIDE the craft-inline fence below, whose contents are
// byte-compared against lib/run-record.mjs.
const CRAFT_VERSION = '0.25.0' // x-release-please-version

// ---- run-record helpers (VERBATIM mirror of lib/run-record.mjs — the sandbox can't import; keep in sync) ----
// >>> craft-inline lib/run-record.mjs SEVERITIES countBySeverity summarizeFindings tallyVerdicts repoRefusal
/** @type {Severity[]} */
const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Info']

/**
 * @param {unknown} findings
 * @returns {Record<Severity, number>}
 */
function countBySeverity(findings) {
  const by = { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 }
  for (const f of (Array.isArray(findings) ? findings : [])) {
    if (f && Object.prototype.hasOwnProperty.call(by, f.severity)) by[/** @type {Severity} */ (f.severity)] += 1
  }
  return by
}

/**
 * @param {unknown} findings
 * @returns {{ total: number, bySeverity: Record<Severity, number> }}
 */
function summarizeFindings(findings) {
  const bySeverity = countBySeverity(findings)
  return { total: SEVERITIES.reduce((n, s) => n + bySeverity[s], 0), bySeverity }
}

/**
 * @param {unknown} entries
 * @returns {Record<TriageVerdict, number>}
 */
function tallyVerdicts(entries) {
  const t = { accept: 0, reject: 0, defer: 0, 'needs-decision': 0, conflict: 0 }
  for (const e of (Array.isArray(entries) ? entries : [])) {
    if (e && Object.prototype.hasOwnProperty.call(t, e.verdict)) t[/** @type {TriageVerdict} */ (e.verdict)] += 1
  }
  return t
}

/**
 * @param {{ engine: string, repo: string, craftVersion: string, outputTokens: number, via?: string }} o
 *   `via`: the parent workflow that dispatched this run, '' when it was not nested
 */
function repoRefusal({ engine, repo, craftVersion, outputTokens, via = '' }) {
  return {
    record: {
      schemaVersion: 1, runtime: 'claude-code', craftVersion, kind: 'workflow', name: engine,
      nested: !!via, via: via || null,
      verdict: 'INCOMPLETE (repo not supported)', findings: summarizeFindings([]), dimensions: [], verification: null,
      notRun: ['`repo` argument refused — this engine reviews only the session\'s own checkout'],
      outputTokens,
    },
    report: [
      `## Verdict`,
      `⚠️ INCOMPLETE — \`repo=${repo}\` was given, but \`${engine}\` does not support reviewing a repository other than the one this session runs in: its agents would read THIS checkout and report a normal-looking verdict for the wrong code. Nothing ran.`,
      ``,
      `Either run \`craft:review\` with \`repo=\` (that engine threads a working-directory directive through its prompts), or start a session inside that repository and run \`${engine}\` there.`,
    ].join('\n'),
  }
}
// <<< craft-inline
// ---- the one write path (shared with every other record-filing engine) ----
// The sandbox cannot import, so lib/run-logging.mjs reaches this script the same way run-record.mjs
// does: a fenced region regenerated and byte-compared by `node lib/check-workflows.mjs`.
// >>> craft-inline lib/run-logging.mjs LOGRUN_SCHEMA shq loggerPrelude payloadVersion engineRevisionFlag runDirFlags logRunPrompt logRunDispatch logRunOutcome quietly makeRunLogger telemetryLossNoter
const LOGRUN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: {
    ok: { type: 'boolean', description: 'true only if the script ran and printed no craft-log-run FAILED line' },
    error: { type: 'string', description: 'when ok is false, the failing line verbatim; when ok is true AND the script printed a craft-log-run WARNING line, that line verbatim; empty otherwise' },
  },
}

/** @param {unknown} s */
function shq(s) { return `'${String(s ?? '').replace(/'/g, `'\\''`)}'` }

/**
 * @param {string | undefined} craftRoot
 * @param {string} [version]
 * @param {string} [repo]
 */
function loggerPrelude(craftRoot, version = '', repo = '') {
  const preamble = `CRAFT_REPO="$(cd ${shq(repo || '.')} 2>/dev/null && pwd -P)" || CRAFT_REPO=""
craft_usable() {   # a line that is exactly '}' at column 0 would end the extracted region early
  case "$1" in /*) ;; *) return 1 ;; esac
  [ -f "$1" ] || return 1
  [ -n "$CRAFT_REPO" ] || return 1   # belt to the braces below; see the note in the comment above
  # A repo of "/" contains everything, so nothing can be outside it. The pattern below cannot say
  # that: "$CRAFT_REPO"/* becomes //* and matches no ordinary path, so every candidate reads as
  # outside and the guard inverts into an allow-all. Degenerate input, but the whole point of this
  # predicate is that it fails closed.
  [ "$CRAFT_REPO" = "/" ] && return 1
  CRAFT_REAL="$1"
  CRAFT_HOPS=0
  while [ -L "$CRAFT_REAL" ]; do
    [ "$CRAFT_HOPS" -lt 16 ] || return 1
    CRAFT_LINK="$(readlink "$CRAFT_REAL")"
    case "$CRAFT_LINK" in
      /*) CRAFT_REAL="$CRAFT_LINK" ;;
      *) CRAFT_REAL="$(dirname "$CRAFT_REAL")/$CRAFT_LINK" ;;
    esac
    CRAFT_HOPS=$((CRAFT_HOPS + 1))
  done
  CRAFT_DIR="$(cd "$(dirname "$CRAFT_REAL")" 2>/dev/null && pwd -P)" || return 1
  [ -n "$CRAFT_DIR" ] || return 1
  CRAFT_REAL="$CRAFT_DIR/$(basename "$CRAFT_REAL")"
  case "$CRAFT_REAL" in
    "$CRAFT_REPO"/*|"$CRAFT_REPO") return 1 ;;
  esac
  return 0
 }
CRAFT_LOGGER=""
`
  /** @param {string} expr */
  const tryCandidate = expr => `if [ -z "\${CRAFT_LOGGER:-}" ]; then
  CRAFT_TRY=${expr}
  craft_usable "$CRAFT_TRY" && CRAFT_LOGGER="$CRAFT_REAL"
fi
`
  const explicit = craftRoot ? tryCandidate(`${shq(craftRoot)}"/lib/craft-log-run.mjs"`) : ''
  const fromEnv = tryCandidate('"${CLAUDE_PLUGIN_ROOT:-}/lib/craft-log-run.mjs"')
  const installed = version
    ? tryCandidate(`"\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/craft/craft/"${shq(version)}"/lib/craft-log-run.mjs"`)
    : ''
  return `${preamble}${explicit}${fromEnv}${installed}[ -n "\${CRAFT_LOGGER:-}" ] || { echo "craft-log-run FAILED: no usable logger — no absolute craftRoot outside the reviewed repo, no CLAUDE_PLUGIN_ROOT, and no installed copy of "${version ? shq(version) : "'this version'"}" under the plugin cache; refusing to resolve against the reviewed repository"; exit 1; }
`
}

/** @param {unknown} payload @returns {string} */
function payloadVersion(payload) {
  return String((payload && typeof payload === 'object' ? /** @type {{ craftVersion?: unknown }} */ (payload).craftVersion : undefined) ?? '')
}

/** @param {unknown} payload @returns {string} */
function engineRevisionFlag(payload) {
  const rev = payload && typeof payload === 'object' ? /** @type {{ workflowEngineRevision?: unknown }} */ (payload).workflowEngineRevision : undefined
  return Number.isInteger(rev) ? `--engine-revision ${rev} ` : ''
}

/** @param {string} dir @param {boolean} rejoin @returns {string} */
function runDirFlags(dir, rejoin) {
  return `${dir ? `--dir ${shq(dir)} ` : ''}${rejoin ? '--rejoin ' : ''}\${CLAUDE_CODE_SESSION_ID:+--session "$CLAUDE_CODE_SESSION_ID"} `
}

/** @param {{ record?: unknown, craftRoot?: string, repo?: string, command?: string, dir?: string, rejoin?: boolean }} [opts] */
function logRunPrompt({ record, craftRoot = '', repo = '', command = 'write', dir = '', rejoin = false } = {}) {
  const version = payloadVersion(record)
  const flags = runDirFlags(dir, rejoin)
  return `You are the craft observability logger. Persist ONE run record. This is mechanical IO — do not analyze, summarise, reformat or "clean up" any part of it.

Run exactly this:

\`\`\`
${loggerPrelude(craftRoot, version, repo)}CRAFT_REC="$(mktemp "\${TMPDIR:-/tmp}/craft-rec.XXXXXX")"
cat > "$CRAFT_REC" <<'CRAFT_RECORD_EOF'
…RECORD below, byte for byte…
CRAFT_RECORD_EOF
cd ${shq(repo || '.')} && node "$CRAFT_LOGGER" ${command} ${engineRevisionFlag(record)}${flags}--project "$PWD" < "$CRAFT_REC"; CRAFT_RC=$?; rm -f "$CRAFT_REC"; exit $CRAFT_RC
\`\`\`

The script computes every field (ts, project, commit, dirty, engineRevision, craftCommit, and — reading the working copy with git — branch and head, whose values in the record below are only a fallback for what git cannot resolve), names the file, appends the index line and verifies the readback. You compute NONE of that. In particular: do NOT \`mkdir\` the store, do NOT run \`date\`, \`pwd\` or \`git\` yourself, and do NOT append to index.jsonl by hand.

COPY THE RECORD VERBATIM into the quoted heredoc — it can be hundreds of KB (findings, ledger, dimensions), and re-emitting it from memory silently drops the big arrays. That is exactly how a completed review once persisted \`findings: 111\` with \`dimensions: []\` and no \`verification\`, destroying the per-lens telemetry the whole store exists for.

If the script prints a line starting \`craft-log-run FAILED\`, or the command itself fails (for example the logger path does not exist), return {"ok": false, "error": "<that line, or the shell error, verbatim>"} and stop — do NOT fall back to writing the file by hand. If it succeeded, return {"ok": true} — and if it ALSO printed a line starting \`craft-log-run WARNING\`, return {"ok": true, "error": "<that line verbatim>"}: the record landed, but something about the run directory did not, and the engine has to be able to say so. Best-effort either way: never error the run over this.

RECORD:
${JSON.stringify(record, null, 2)}`
}

/**
 * @param {unknown} record
 * @param {{ phase?: string }} [opts]
 * @returns {{ label: string, phase: string, schema: typeof LOGRUN_SCHEMA, model: 'sonnet' | 'haiku', effort: 'low' }}
 */
function logRunDispatch(record, { phase = '' } = {}) {
  const payloadKB = JSON.stringify(record).length / 1024
  const big = payloadKB > 24
  return {
    label: `log-run${big ? ` (${Math.round(payloadKB)}KB)` : ''}`,
    phase,
    schema: LOGRUN_SCHEMA,
    model: big ? 'sonnet' : 'haiku',
    effort: 'low',
  }
}

/**
 * @param {unknown} res harness result of the logger agent (model output), or a quiet call's `{ __threw }`
 * @returns {{ ok: boolean, reason: string }}
 */
function logRunOutcome(res) {
  const r = res && typeof res === 'object' ? /** @type {{ ok?: unknown, error?: unknown, __threw?: unknown }} */ (res) : null
  if (r && r.ok === true) return { ok: true, reason: String((r.error || '')).trim() }
  return { ok: false, reason: String((r && (r.__threw || r.error)) || 'the logger agent returned no result') }
}

/**
 * @template P, O, R
 * @param {(prompt: P, opts: O) => Promise<R>} call a harness agent callback
 * @returns {(prompt: P, opts: O) => Promise<R | { __threw: string }>}
 */
function quietly(call) {
  return async (prompt, opts) => {
    try {
      return await call(prompt, opts)
    } catch (e) {
      return { __threw: String((e && /** @type {{ message?: unknown }} */ (e).message) || e) }
    }
  }
}

/**
 * @template O
 * @param {object} o
 * @param {(prompt: string, opts: ReturnType<typeof logRunDispatch>) => Promise<O>} o.call  a `quietly`-wrapped agent callback
 * @param {string} o.phase
 * @param {() => { craftRoot?: string, repo?: string, command?: string, dir?: string, rejoin?: boolean }} o.target
 * @param {(what: string, why: string, landed: boolean) => void} o.noteLoss
 * @param {(record: Record<string, unknown>) => Record<string, unknown>} [o.prepare]
 * @returns {(record: Record<string, unknown>) => Promise<void>}
 */
function makeRunLogger({ call, phase, target, noteLoss, prepare = record => record }) {
  return async recordIn => {
    const record = prepare(recordIn)
    const landed = logRunOutcome(await call(logRunPrompt({ ...target(), record }), logRunDispatch(record, { phase })))
    if (!landed.ok) noteLoss('the run record', landed.reason, false)
    else if (landed.reason) noteLoss('the run directory (the record itself landed)', landed.reason, true)
  }
}

/**
 * @param {string[]} lost
 * @param {(line: string) => void} say
 * @returns {(what: string, why: string, landed: boolean) => void}
 */
function telemetryLossNoter(lost, say) {
  return (what, why, landed) => {
    lost.push(`${what} — ${why}`)
    say(landed ? `⚠️ telemetry: ${why}` : `⚠️ telemetry lost: ${what} — ${why}`)
  }
}
// <<< craft-inline
// The banner that leads the plan when a write did not land — the same one review.js uses.
// >>> craft-inline lib/review-coverage.mjs telemetryLostSection
/** @param {unknown} lost */
function telemetryLostSection(lost) {
  const lines = /** @type {unknown[]} */ (Array.isArray(lost) ? lost : []).filter(l => String(l ?? '').trim())
  if (!lines.length) return ''
  const landed = lines.filter(l => /^the run directory \(the record itself landed\)/.test(String(l)))
  const unconfirmed = lines.length - landed.length
  const head = unconfirmed
    ? `${unconfirmed} record write(s)/read(s) for this run could not be confirmed, so the run store may be missing or incomplete for it. Read the verdict below — not the store — for what this run actually did.`
    : `This run's record is in the store, but ${landed.length} run director${landed.length === 1 ? 'y' : 'ies'} could not be folded into it, so what those held is not there. Read the verdict below for what this run actually did.`
  return [
    unconfirmed ? `## ⚠️ Telemetry lost` : `## ⚠️ Telemetry incomplete`,
    head,
    ...lines.map(l => `- ${String(l).replace(/[\r\n]+/g, ' ').slice(0, 300)}`),
    ``,
    ``,
  ].join('\n')
}
// <<< craft-inline

// A lost record NEVER fails the triage: killing it over a bookkeeping write would teach everyone to
// ignore the very marker this exists to raise. It is reported instead, at the head of the plan a
// human actually reads — an empty store is otherwise indistinguishable from "never run".
/** @type {string[]} */
const telemetryLost = []
// The shared run-record writer (lib/run-logging.mjs), bound to this engine's phase and loss note.
const logRun = makeRunLogger({
  call: quietly(agent), phase: 'Plan', target: () => ({ craftRoot: craftRootArg }),
  noteLoss: telemetryLossNoter(telemetryLost, log),
})

// ---- Gather --------------------------------------------------------------
// `repo` is NOT supported by this engine: every agent it dispatches runs git/cargo wherever the
// session sits. Accepting it silently is the failure this family exists to end — the caller names
// another repository, the engine reads its own, and the verdict looks entirely normal for the wrong
// code (measured 2026-09-17 on `review`, before `repo` reached that engine's argument list: 57
// agents, 2.04M tokens, nothing reviewed). Refuse before anything runs, and name what does work.
// The comment above used to promise this argument while nothing read it (realm @nick/craft, #65).
// MOVED here from the argument block, and the move IS the fix. Refused up there it returned before
// `logRun` and its dependencies existed, so a repeatedly mis-dispatched engine filed no record at
// all — and `notRun` fragility ranking, which is the one place a repeated wrong dispatch would show
// up, never saw it. This is still before the first phase, so nothing has run when it refuses.
if (A['repo']) {
  const refused = repoRefusal({ engine: 'triage-findings', repo: String(A['repo']), craftVersion: CRAFT_VERSION, outputTokens: budget.spent() })
  await logRun(refused.record)
  return refused.report
}


phase('Gather')
if (!pr && !report) {
  throw new Error('triage-findings needs a source: pass args.pr (GitHub PR number) and/or args.report (path to a rust-audit report).')
}

/**
 * One gather task per requested source, and the source each stands for, in the same order: the
 * locators drive NOT-RUN bookkeeping for the run record.
 * @returns {{ gatherTasks: Array<() => Promise<RawResult | null>>, requestedLocators: string[] }}
 */
function gatherPlan() {
  /** @type {Array<() => Promise<RawResult | null>>} */
  const gatherTasks = []
  /** @type {string[]} */
  const requestedLocators = []
  if (report) {
    requestedLocators.push('report')
    gatherTasks.push(() => /** @type {Promise<RawResult | null>} */ (agent(
      `Read the review report at \`${report}\`. Extract every finding into the schema. Set source to "rust-audit" (or "rust-reviewer" for a single reviewer verdict). Copy severity/title/location/detail verbatim; leave proposed_fix and thread_id empty unless present. The report's \`## Tool finding titles (verbatim)\` section (also nested under \`## Prior decisions in the nested reviews (verbatim)\`) lists titles, not findings: never extract its rows as findings. For a finding at a \`file:line\` it lists, take the title from it — the listed title equal to the finding's line, or the only one listed there; when several are listed and none is equal, keep the finding's own line, never a guess between them.`,
      { label: 'gather:report', phase: 'Gather', schema: RAW_SCHEMA },
    )))
  }
  if (pr) {
    requestedLocators.push('pr')
    gatherTasks.push(() => /** @type {Promise<RawResult | null>} */ (agent(
      `Gather inline review comments from GitHub PR #${pr}. Resolve the repo with \`gh repo view --json owner,name\`, then \`gh api repos/{owner}/{repo}/pulls/${pr}/comments --paginate\`. For each UNRESOLVED, non-outdated review comment make one finding: title = short summary, location = \`<path>:<line>\` (path + line/original_line), detail = the comment body, thread_id = the comment/thread id, severity = your best estimate (Critical|High|Medium|Low|Info), proposed_fix = empty. Set source = "github-pr".`,
      { label: 'gather:pr', phase: 'Gather', schema: RAW_SCHEMA },
    )))
  }
  return { gatherTasks, requestedLocators }
}

const { gatherTasks, requestedLocators } = gatherPlan()
const gatherResults = await parallel(gatherTasks)   // order preserved → align with requestedLocators
const notRunSources = requestedLocators.filter((_, i) => !gatherResults[i])
if (notRunSources.length) log(`WARNING: source(s) that produced nothing: ${notRunSources.join(', ')} — the triage covers fewer sources than asked.`)
const gathered = gatherResults.filter(g => !!g)
/** @type {SourcedFinding[]} */
const raw = gathered.flatMap(g => (Array.isArray(g.findings) ? g.findings : []).map(f => ({ ...f, source: g.source })))
log(`Gathered ${raw.length} raw finding(s) from ${gathered.length} source(s).`)

// stable composite id; reused for dedup, ledger, and idempotent re-runs
/** @param {SourcedFinding} f */
const idOf = f => `${f.source}::${f.location || 'no-loc'}::${f.title}`
// The prior ledger arrives in args, so an entry is read only as far as it is an object, its fields as text.
/** @param {unknown[]} entries @returns {Map<string, LedgerEntry>} */
function ledgerById(entries) {
  /** @type {Map<string, LedgerEntry>} */
  const byId = new Map()
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue
    const x = /** @type {Record<string, unknown>} */ (e)
    byId.set(String(x['stable_id']), { stable_id: String(x['stable_id']), verdict: String(x['verdict'] ?? ''), reason: String(x['reason'] ?? '') })
  }
  return byId
}
const priorById = ledgerById(priorLedger)

// ---- Validate ------------------------------------------------------------
phase('Validate')
const pin = base
  ? `Validate against ref \`${base}\` (the ref the findings were generated against), not the live working tree.`
  : 'Validate against the currently checked-out tree.'

// The sentinel that marks a `needs-decision` nothing actually judged. It rides in the ledger entry's
// `reason` (a carry-forward prefixes that reason, so `includes` is the test, not equality) and it
// is what keeps such an entry OUT of the carry-forward set on the next run.
const UNJUDGED_MARKER = 'NOT JUDGED'

/** @type {string[]} */
const deadValidations = []
/** One finding's verdict: carried from the prior ledger when settled there, else judged by an agent. @param {SourcedFinding} f @returns {Promise<Validation>} */
function validateOne(f) {
  const id = idOf(f)
  const prior = priorById.get(id)
  // Idempotent re-run: carry a prior *settled* verdict rather than re-litigating it. `accept` is
  // re-validated (the code may have changed since); `conflict` is a cross-finding judgement, so it
  // is re-derived fresh in the Plan phase rather than carried as a stale solo verdict.
  // ...but a finding whose validator DIED is not settled — nothing judged it. Its stand-in verdict
  // is `needs-decision` (the vocabulary downstream already understands), so without this it would
  // be carried forward as settled on the next run: no agent re-opens it, `deadValidations` stays
  // empty, and run two emits no INCOMPLETE banner and no notRun entry over a finding no agent ever
  // read. The marker in the reason is what distinguishes it — a fifth verdict would have to be
  // taught to VALIDATION_SCHEMA, PLAN_SCHEMA, the plan prompt and tallyVerdicts, all of which
  // enumerate the four, and a ledger entry the tally does not know is silently uncounted.
  const neverJudged = prior && String(prior.reason || '').includes(UNJUDGED_MARKER)
  if (prior && !neverJudged && ['reject', 'defer', 'needs-decision'].includes(prior.verdict)) {
    // Carried verdicts skip the agent, so they carry no fresh premise check — say so rather than
    // leaving the field undefined and letting the plan stage read it as "checked, found nothing".
    return Promise.resolve({ stable_id: id, verdict: prior.verdict, reason: `carried from prior run: ${prior.reason}`, fix_pointer: '', premise_checked: '(carried from prior run — not re-checked)' })
  }
  return /** @type {Promise<Validation | null>} */ (agent(
    `Judge ONE review finding against the actual code. ${pin}

Finding (source: ${f.source}):
- severity: ${f.severity}
- location: ${f.location || '(none given)'}
- what: ${f.title}
- why: ${f.detail}
${f.proposed_fix ? `- proposed fix: ${f.proposed_fix}` : ''}

Read the cited code, then decide ONE verdict:
- accept — a real, in-scope problem. fix_pointer = owning craft skill (rust-errors/rust-ownership/rust-concurrency/rust-security/rust-performance/rust-idioms/rust-testing/rust-unsafe) + a one-line fix direction.
- reject — not a real problem / wrong; explain why (this becomes reviewer pushback).
- defer — real but out of scope now; say why.
- needs-decision — valid but needs a product/spec decision, OR the finding has no resolvable location; say what is needed.

PREMISE DISCIPLINE: name the ONE claim your verdict rests on. If it lives outside the cited location — the dependency behaves this way, this is reachable from untrusted input, a caller already guards it, the sibling path does X — OPEN that code (dependency sources included) and record the file:line in premise_checked. This binds **reject** exactly as much as accept: "a caller must already validate this" waved through without opening the caller is the same unfounded claim as the finding it dismisses, and it silently discards a real bug. If you cannot open it, do not guess — verdict needs-decision, saying which premise is unverified.

stable_id MUST be exactly: ${id}
Keep reason to one line. fix_pointer empty unless verdict is accept.`,
    { label: `validate:${(f.location || f.title).slice(0, 40)}`, phase: 'Validate', schema: VALIDATION_SCHEMA },
  )).then(v => {
    // A dead validator used to be dropped by `filter(Boolean)`, which removed the finding from the
    // plan AND from the ledger: a Critical whose judge died did not appear as unjudged, it appeared
    // as nothing. It is unjudged, so it becomes the verdict that already means "a human must look
    // at this" — the one downstream vocabulary (carry-forward, prompt, ledger) already understands.
    if (v) return v
    deadValidations.push(id)
    return { stable_id: id, verdict: 'needs-decision', reason: `${UNJUDGED_MARKER} — the validator agent died; this finding was never checked against the code`, fix_pointer: '', premise_checked: '(validator died — nothing was opened)' }
  })
}
const validations = (await parallel(raw.map(f => () => validateOne(f)))).filter(v => !!v)

const accepted = validations.filter(v => v.verdict === 'accept')
log(`Validated ${validations.length}: ${accepted.length} accept, ${validations.length - accepted.length} other.`)
if (deadValidations.length) log(`WARNING: ${deadValidations.length} validator(s) died -> carried as needs-decision (unjudged), not dropped.`)

// ---- Plan ----------------------------------------------------------------
phase('Plan')
// Re-attach each accepted validation's raw finding so the planner has location/detail.
const rawById = new Map(raw.map(f => [idOf(f), f]))
const acceptedEnriched = accepted.map(v => ({ ...v, finding: rawById.get(v.stable_id) || null }))

const plan = /** @type {TriagePlan | null} */ (await agent(
  `Turn validated review findings into ONE fix plan. Do not invent findings; only organise what is given. Ignore any ACCEPTED entry whose \`finding\` is null (a data glitch) — leave it out of the plan and note it in the summary.

1. Dedup by stable_id (merge findings at the same location with the same fix).
2. Detect conflicts — two findings demanding opposite changes. Mark each such finding verdict "conflict" in the ledger, DO NOT put it in the plan, and surface both in the summary for a human to decide.
3. Group the remaining accepted findings by file; order groups blocking (Critical/High) → simple → complex.
4. Render plan_markdown as a checkbox-task plan: one task per file-group, bite-sized checkbox steps, each step naming the file and the owning craft skill; a bug fix starts with a RED→GREEN regression test. Mark independent file-groups as parallelisable (one subagent per group).
5. ledger = EVERY finding (accept/reject/defer/needs-decision/conflict) keyed by stable_id with verdict + one-line reason. Any reason containing "${UNJUDGED_MARKER}" must be copied VERBATIM, marker included — that string is what tells a later re-run this finding was never actually judged; paraphrasing it makes the finding look settled forever. summary = human-readable rundown of everything not in the plan.

ACCEPTED (with their findings):
${JSON.stringify(acceptedEnriched, null, 2)}

ALL VERDICTS (include reject/defer/needs-decision in the ledger):
${JSON.stringify(validations, null, 2)}`,
  { label: 'plan', phase: 'Plan', schema: PLAN_SCHEMA },
))

// ---- Observability: persist a run record (best-effort) -------------------
// Prefer the plan's ledger (it carries the cross-finding `conflict` disposition); fall back to the
// solo validations when the Plan phase produced nothing.
/**
 * The ledger the record tallies, set back on the plan when the marker had to be re-injected.
 * @param {TriagePlan | null} plan @returns {LedgerEntry[]}
 */
function finalLedger(plan) {
  if (!plan || !Array.isArray(plan.ledger)) return validations
  // The prompt above ASKS the plan agent to copy the marker verbatim; asking is not a guarantee. A
  // summarising model paraphrases a one-line free-text reason as a matter of course, and the marker
  // is the ONLY thing that tells the next run this finding was never judged: lose it and the finding
  // reads as settled forever — exactly the bug this marker exists to prevent, returning silently on
  // run three. So the script re-injects it deterministically. `validations` is the local record of
  // what each finding's verdict actually was, so a marked reason is restored (and a dropped entry
  // re-added) regardless of what the agent returned. The prompt instruction stays as belt and braces.
  const unjudged = new Map(validations.filter(v => String(v.reason || '').includes(UNJUDGED_MARKER)).map(v => [v.stable_id, v]))
  if (!unjudged.size) return plan.ledger
  /** @type {Set<string>} */
  const seen = new Set()
  const ledger = plan.ledger.map(e => {
    const v = e && unjudged.get(e.stable_id)
    if (!v) return e
    seen.add(e.stable_id)
    return String(e.reason || '').includes(UNJUDGED_MARKER) ? e : { ...e, verdict: v.verdict, reason: v.reason }
  })
  for (const [id, v] of unjudged) if (!seen.has(id)) ledger.push({ stable_id: id, verdict: v.verdict, reason: v.reason })
  plan.ledger = ledger
  return ledger
}
const ledger = finalLedger(plan)
await logRun({
  schemaVersion: 1,
  runtime: 'claude-code',
  craftVersion: CRAFT_VERSION,
  kind: 'workflow',
  name: 'triage-findings',
  verdict: '',                         // triage yields per-finding dispositions, not an Approve/Block verdict
  findings: summarizeFindings(raw),    // total findings triaged + severity mix
  nested: false,
  via: null,
  sources: gathered.map(g => ({ source: g.source, count: Array.isArray(g.findings) ? g.findings.length : 0 })),
  triage: { gathered: raw.length, validated: validations.length, ...tallyVerdicts(ledger) },
  // Bare, aggregatable labels — NOT the human sentences below. `lib/analyze-runs.mjs` ranks
  // `notRun` by exact string to surface fragility that REPEATS across runs, and a note embedding a
  // count ("3 finding(s) were never judged") is unique per run: it fills the ranking with count-1
  // rows and sinks the real repeats. The sentences belong to the banner, which a person reads once.
  notRun: notRunSources.map(src => `gather:${src}`)
    .concat(deadValidations.length ? ['findings-unjudged'] : []),
})

if (!plan) return `${telemetryLostSection(telemetryLost)}Triage failed: the Plan-phase agent returned no result. Re-run, or triage the findings manually.`

/** The plan as its reader gets it: led by what did not run and by a write that did not land. @param {TriagePlan} plan @returns {TriagePlan} */
function bannered(plan) {
  // What did not run has to reach the READER of the plan, not just the run record. A dead `gather:pr`
  // agent means the plan covers fewer sources than were asked for, and a plan that says nothing about
  // it is indistinguishable from one that covered everything.
  const incomplete = notRunSources.map(src => `source \`${src}\` produced nothing — its findings are NOT in this plan`)
    .concat(deadValidations.length ? [`${deadValidations.length} finding(s) were never judged against the code (validator died); they sit in the ledger as needs-decision, not in the plan`] : [])
  if (incomplete.length) {
    const banner = ['> **INCOMPLETE TRIAGE** — this plan does not cover everything that was asked for:', ...incomplete.map(l => `> - ${l}`), ''].join('\n')
    plan.plan_markdown = `${banner}\n${plan.plan_markdown ?? ''}`
    plan.summary = `INCOMPLETE: ${incomplete.join('; ')}\n\n${plan.summary ?? ''}`
    plan.notRun = incomplete
  }
  // A write that did not land leads the plan: a reader about to look this triage up in the store has
  // to learn here that it may not be there.
  const lostBanner = telemetryLostSection(telemetryLost)
  if (lostBanner) {
    plan.plan_markdown = `${lostBanner}${plan.plan_markdown ?? ''}`
    plan.telemetryLost = telemetryLost.slice()
  }
  return plan
}
return bannered(plan)
