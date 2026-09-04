export const meta = {
  name: 'adversarial-review',
  description: 'Adversarial multi-phase diff review with bounded verifier fan-out — scout-scaled lenses, throttled batches with retries, strict-majority verification, verified coverage gaps. A run whose scout, lenses or coverage critic died reports its verdict as INCOMPLETE with a not-run list, never as a clean approval; unjudged individual checks are recorded as advisory instead. Subscription-friendly: steady request rate, no burst.',
  whenToUse: 'Deep adversarial, language-agnostic review of any diff — mixed / non-Rust-Nix codebases, or when money-path (payments/ledger) invariants matter, or on a rate-limited subscription (steady request rate). For a Rust or Nix diff prefer the `review` workflow (auto-detects language). Distinct from `review --strict`, which is the harsh maintainability-block mode of the generic engine.',
  phases: [
    { title: 'Prep', detail: 'scout the diff (size, lens subset) + warm up the codebase-memory index', model: 'haiku' },
    { title: 'Review', detail: 'scout-picked finder lenses, throttled batches with retries; two-tier dedup (mechanical + thresholded semantic clusterer)' },
    { title: 'Verify', detail: '1 combined verifier per finding, 3-lens panel for critical/high; throttled + retries + budget guard' },
    { title: 'Coverage', detail: 'completeness critic; its gaps are verified through the same pipeline' },
  ],
}

// ---- args ----
// ---- args ----
// Three plausible spellings arrive here — a real object, a JSON string, and the `key=value` form the
// skill's own invocation line advertises — and only the first used to work. The other two fell
// through every `typeof args === 'object'` guard, so every option reverted to its default and the
// run reviewed whatever the session was sitting in, then reported a confident verdict for a diff
// nobody asked about. Shared with every other engine (lib/workflow-args.mjs, inlined below).
// >>> craft-inline lib/workflow-args.mjs parseOptions normalizeArgs
// Only `key=value` counts as an option, and that is a deliberate narrowing rather than a limitation.
// A bare word cannot become a flag: once any pair is present, the rest of an unquoted sentence would
// otherwise turn into options nobody wrote — `base=v1 intent=review the auth refactor strict` would
// invent `strict`, and an invented `strict` changes what the run does. A flag is written `strict=true`
// or `--strict`; a leading dash is an unambiguous statement of intent, a bare word is not.
function parseOptions(text) {
  const pair = /(--?)?(\w[\w-]*)=("([^"]*)"|'([^']*)'|\S+)|(--)(\w[\w-]*)/g
  const out = {}
  let pairs = 0
  const ignored = []
  let m
  let cursor = 0
  while ((m = pair.exec(text)) !== null) {
    // Anything skipped over between matches is prose, not an option: collect it so the caller can say
    // what it ignored instead of silently swallowing half the input.
    const gap = text.slice(cursor, m.index).trim()
    if (gap) ignored.push(...gap.split(/\s+/))
    cursor = pair.lastIndex
    // Self-contained on purpose: a module-level helper would not be copied into the engines' inlined
    // regions unless it were exported, and the fence's sibling check only knows about EXPORTS — a
    // private helper reaches every engine as a ReferenceError on first use, with the gate green.
    const banned = k => k === '__proto__' || k === 'constructor' || k === 'prototype'
    if (m[7]) { if (banned(m[7])) ignored.push(m[7]); else { out[m[7]] = true; pairs++ } ; continue }
    const key = m[2]
    // `__proto__` is a live setter on a plain object: `__proto__={"craftRoot":"/evil"}` stores no own
    // key and yet makes `A.craftRoot` read `/evil`, which is interpolated into the shell instructions
    // the logger agent is handed. The args string is model-composed, so this is the same threat shape
    // as a model-supplied path, reached by a quieter door. A null-prototype object does not fix it on
    // its own — `Object.assign` back to a plain object re-triggers the setter — and these are never
    // legitimate option names, so they are refused by name and reported.
    if (banned(key)) { ignored.push(key); continue }
    const quoted = m[4] ?? m[5]
    if (quoted !== undefined) { out[key] = quoted; pairs++; continue }
    try {
      out[key] = JSON.parse(m[3])
    } catch {
      out[key] = m[3]
    }
    pairs++
  }
  const tail = text.slice(cursor).trim()
  if (tail) ignored.push(...tail.split(/\s+/))
  return { options: out, pairs, ignored }
}

function normalizeArgs(args, warn = () => {}) {
  if (args && typeof args === 'object' && !Array.isArray(args)) return args
  if (typeof args !== 'string' || !args.trim()) return {}
  const text = args.trim()
  // A JSON scalar or array is not an options object, and must not be mistaken for the key=value form
  // below: `[1,2,3]` and `"a sentence"` would otherwise become flags named after their own contents.
  if (text.startsWith('[') || text.startsWith('"')) {
    warn(`⚠️ args arrived as a JSON value that is not an object (${text.slice(0, 40)}) — ALL options ignored, running with defaults`)
    return {}
  }
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        warn('⚠️ args arrived as a JSON string, not an object — parsed it; pass a real object to avoid this')
        return parsed
      }
      warn('⚠️ args arrived as a non-object JSON value — ALL options ignored, running with defaults')
      return {}
    } catch (e) {
      warn(`⚠️ args arrived as a string that looks like JSON but is not (${String((e && e.message) || e).slice(0, 60)}) — ALL options ignored, running with defaults`)
      return {}
    }
  }
  const { options, pairs, ignored } = parseOptions(text)
  if (pairs) {
    // Counted, not inferred from the values: `mutants=true` is a pair whose value is boolean true,
    // and testing "is any value not true" threw away every string made only of boolean options —
    // `mutants=true` became {} with a warning saying the input was not understood, which is how a
    // requested mutation pass would silently not run.
    warn('⚠️ args arrived as a key=value string — parsed it; pass a real object to avoid this')
    if (ignored.length) {
      warn(`⚠️ ignored ${ignored.length} word(s) in args that are not options (${ignored.slice(0, 6).join(' ')}) — quote a value that contains spaces`)
    }
    return options
  }
  // Reaching here means a non-empty string that is neither JSON nor a single recognizable pair. The
  // loud path matters more than it looks: this is the branch a typo lands in, and defaults produce a
  // verdict that reads exactly like a requested one.
  warn(`⚠️ args arrived as an unrecognized string (${text.slice(0, 40)}) — ALL options ignored, running with defaults`)
  return {}
}
// <<< craft-inline
const A = normalizeArgs(args, log)

const diffBase = A.diffBase ? String(A.diffBase) : ''
const intentArg = A.intent ? String(A.intent) : ''
const viaArg = A._via ? String(A._via) : ''   // set by a parent workflow
// The repo under review, when it is NOT the directory the session runs in, and where craft itself
// lives so the logger can find lib/craft-log-run.mjs. As an installed plugin CLAUDE_PLUGIN_ROOT is
// set for us; launched by scriptPath from a checkout it is NOT, and the fallback would resolve
// against the reviewed repo — where the script is not. Pass craftRoot then.
const craftRootArg = A.craftRoot ? String(A.craftRoot) : ''
const BATCH = A.batch ? Math.max(1, Number(A.batch)) : 4
const RETRY_BATCH = 2                 // retry rounds run even quieter than the main pass
const MAX_RETRY_ROUNDS = A.maxRetries != null ? Math.max(0, Number(A.maxRetries)) : 2
const BUDGET_FLOOR = 40_000           // stop spawning agents below this many remaining tokens

// ---- schemas ----
const FINDINGS = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'file', 'line', 'severity', 'description', 'fix', 'whereChecked'],
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'number' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          description: { type: 'string' },
          fix: { type: 'string' },
          whereChecked: { type: 'string', description: 'OFF-SITE EVIDENCE: the file:line you actually opened to establish a load-bearing premise living OUTSIDE the cited line — a dependency\'s behaviour, reachability from an entry point, the absence of a guard in a caller, what a sibling path does. Comma-separate several. Empty string ONLY when the finding rests on no off-site claim at all' },
        },
      },
    },
  },
}
const VERDICT = {
  type: 'object',
  additionalProperties: false,
  required: ['refuted', 'reasoning', 'severity', 'premiseSupported'],
  properties: {
    refuted: { type: 'boolean' },
    premiseSupported: { type: 'boolean', description: 'true if the load-bearing premise is self-contained at the cited line or actually shown by the code at whereChecked; false if it is an off-site claim with no evidence that checks out. Unsupported is NOT the same as refuted — set refuted on its own merits' },
    reasoning: { type: 'string' },
    severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'not-an-issue'] },
  },
}
const SCOUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['baseRef', 'sizeBucket', 'lenses', 'changedFiles', 'notes'],
  properties: {
    baseRef: { type: 'string', description: 'git ref the diff was computed against; empty if none resolved' },
    sizeBucket: { type: 'string', enum: ['small', 'medium', 'large'] },
    lenses: { type: 'array', items: { type: 'string' }, description: 'subset of the lens catalog to run' },
    changedFiles: { type: 'array', items: { type: 'string' }, description: 'EVERY path the diff touches, verbatim from `git diff --name-only` against the resolved base — repo-relative, no truncation, no globbing. An empty array means the diff genuinely resolved to no files; it is read as "nothing was reviewed", so never return [] as a shortcut' },
    notes: { type: 'string' },
  },
}
const WARMUP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['indexed', 'notes'],
  properties: {
    indexed: { type: 'boolean', description: 'true if the codebase-memory index exists and covers the diff base' },
    notes: { type: 'string' },
  },
}

// Deterministic re-read of the diff's file list, used only to gate the inert-only green exit.
// `fileCount` comes from `wc -l`, `files` from the same command's output: the two disagreeing is
// how the cross-check's OWN truncation is caught, so both are required.
const CROSSCHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'fileCount', 'files'],
  properties: {
    ok: { type: 'boolean', description: 'true only if git ran and files holds every path it printed, complete and verbatim' },
    fileCount: { type: 'integer', description: 'the number printed by `git diff --name-only <base> | wc -l`' },
    files: { type: 'array', items: { type: 'string' }, description: 'every path from `git diff --name-only <base>`, verbatim, untruncated' },
  },
}

const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 }
const isEscalated = f => f.lens !== 'complexity' && (f.severity === 'critical' || f.severity === 'high')

// The craft release that produced a run. Recorded on the run record and index line so an
// aggregate can be filtered to ONE engine version: without it, runs from every rubric the store
// has ever seen blend together. MUST match `.claude-plugin/plugin.json` — `lib/check-workflows.mjs`
// fails the build if it drifts. Kept OUTSIDE the craft-inline fence below, whose contents are
// byte-compared against lib/run-record.mjs.
const CRAFT_VERSION = '0.18.0' // x-release-please-version

// ---- run-record helpers (VERBATIM mirror of lib/run-record.mjs — the sandbox can't import; keep in sync) ----
// >>> craft-inline lib/run-record.mjs SEVERITIES countBySeverity summarizeFindings
const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Info']

function countBySeverity(findings) {
  const by = { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 }
  for (const f of (Array.isArray(findings) ? findings : [])) {
    if (f && Object.prototype.hasOwnProperty.call(by, f.severity)) by[f.severity] += 1
  }
  return by
}

function summarizeFindings(findings) {
  const bySeverity = countBySeverity(findings)
  return { total: SEVERITIES.reduce((n, s) => n + bySeverity[s], 0), bySeverity }
}
// <<< craft-inline
// ---- the one write path (shared with every other record-filing engine) ----
// The sandbox cannot import, so lib/run-logging.mjs reaches this script the same way run-record.mjs
// does: a fenced region regenerated and byte-compared by `node lib/check-workflows.mjs`.
// >>> craft-inline lib/run-logging.mjs LOGRUN_SCHEMA shq loggerPrelude logRunPrompt logRunDispatch logRunOutcome quietly
// Asked of the logger agent so a failed write is ASSERTED, not inferred from a missing field.
const LOGRUN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: {
    ok: { type: 'boolean', description: 'true only if the script ran and printed no craft-log-run FAILED line' },
    // The description is what the model steers this field by, so it has to name the WARNING case too:
    // reading "empty otherwise" it returns '' on a landed-but-degraded run, and the engine's
    // telemetry-loss branch — the whole reason the field is populated on success — never fires.
    error: { type: 'string', description: 'when ok is false, the failing line verbatim; when ok is true AND the script printed a craft-log-run WARNING line, that line verbatim; empty otherwise' },
  },
}

function shq(s) { return `'${String(s ?? '').replace(/'/g, `'\\''`)}'` }

// Every logger command runs as `cd <reviewed repo> && node <logger>`, so a `:-.` fallback resolved
// AFTER the cd points at the REVIEWED repo, where the script is not — that lost every record to a
// silent "Cannot find module". Resolve the logger to an absolute path FIRST, into a variable, and
// only then change directory. `craftRoot` is passed when the engine is launched by scriptPath from
// a checkout (CLAUDE_PLUGIN_ROOT is unset then); as an installed plugin the env var is set for us.
// The `:-.` fallback is GONE, and that is a security fix, not tidying. It resolved before the `cd`,
// so `.` was the logger agent's starting directory — which, in the deployment this plugin is built
// for, is the repository under REVIEW. A reviewed repository shipping its own `lib/craft-log-run.mjs`
// would then be executed with the user's privileges by a workflow whose whole premise is that the
// reviewed repo is untrusted. Extraction would have carried that from one engine to four.
// It is emitted FIRST, before any staging: `${VAR:?}` is a hard abort in a non-interactive shell, so
// after the `cat` it killed the block before `rm -f` and left the whole record in TMPDIR — on exactly
// the path this loud failure was added for.
// A record that cannot be written is already a reported, non-fatal outcome (logRunOutcome →
// noteTelemetryLoss → the report), so refusing to guess a path costs a marker, not a run.
function loggerPrelude(craftRoot, version = '', repo = '') {
  // ONE pipeline for every way the logger can be located, and that uniformity is the fix rather than
  // a tidy-up. Each source used to get its own treatment: an explicit `craftRoot` returned EARLY,
  // before the absoluteness check and before the refusal, so a review launched with `craftRoot=.`
  // emitted `CRAFT_LOGGER='.'/lib/craft-log-run.mjs` and then `cd <reviewed repo> && node
  // "$CRAFT_LOGGER"` — the removed `:-.` hole restored verbatim, bypassing the version pin and the
  // loud refusal too. `craftRoot` arrives in the model-composed args string, so it is exactly as
  // untrusted as the `--dir` this project already refuses.
  //
  // Three properties now hold for every candidate without exception:
  //   ABSOLUTE — `[ -f ]` is evaluated in the logger agent's cwd while `node` runs AFTER the cd into
  //     the reviewed repository, so any relative path resolves THERE. Refused outright rather than
  //     normalized: guessing what the caller meant is how this class keeps coming back.
  //   PRESENT — a path that names no file is not a logger.
  //   ORDERED — explicit root, then the environment, then this engine's own installed copy. The
  //     search is a fallback, never an override: written the other way round it overwrote a good
  //     path with whatever the cache held, so a launch from a checkout logged through another build.
  //
  // The search is version-pinned to what this engine is stamped with (a record filed by another
  // build's script misdescribes which engine ran, and gets counted), looks only under the user's own
  // plugin cache, honours $CLAUDE_CONFIG_DIR because a session configured that way keeps its plugins
  // elsewhere, and never looks at the reviewed repository at all. That cache layout belongs to the
  // harness, not to craft (realm @nick/craft, node #48 — observed, not documented), so a miss is
  // ordinary: not found means the refusal below, never a guess.
  // ONE predicate, applied to every candidate, and applied BEFORE it is accepted rather than to the
  // winner afterwards. Written as a terminal check on the winner, an explicit craftRoot naming the
  // repo killed the whole command instead of being rejected in favour of the next candidate — which
  // is craft reviewing its own checkout, the mode this repo mandates for itself.
  //
  // A candidate qualifies only if it is ABSOLUTE (`[ -f ]` runs in the agent's cwd while `node` runs
  // after the cd, so a relative path resolves in the reviewed repository), PRESENT, and OUTSIDE the
  // directory the command is about to cd into. The last is checked on the FULLY resolved path:
  // symlinks are followed to their target — a link whose FILE points into the repo passed for one
  // commit because only the directory went through `pwd -P` — and both sides are normalized, so a
  // `..` climb and a symlinked parent collapse to the same comparison. The `case` patterns are
  // quoted and slash-anchored, so a sibling that merely shares a prefix (`/x/repo-evil` beside
  // `/x/repo`) is NOT inside — the collision this project already met once in `insideStore`.
  const preamble = `CRAFT_REPO="$(cd ${shq(repo || '.')} 2>/dev/null && pwd -P)" || CRAFT_REPO=""
craft_usable() {   # a line that is exactly '}' at column 0 would end the extracted region early
  case "$1" in /*) ;; *) return 1 ;; esac
  [ -f "$1" ] || return 1
  CRAFT_REAL="$1"
  CRAFT_HOPS=0
  while [ -L "$CRAFT_REAL" ] && [ "$CRAFT_HOPS" -lt 16 ]; do
    CRAFT_LINK="$(readlink "$CRAFT_REAL")"
    case "$CRAFT_LINK" in
      /*) CRAFT_REAL="$CRAFT_LINK" ;;
      *) CRAFT_REAL="$(dirname "$CRAFT_REAL")/$CRAFT_LINK" ;;
    esac
    CRAFT_HOPS=$((CRAFT_HOPS + 1))
  done
  CRAFT_REAL="$(cd "$(dirname "$CRAFT_REAL")" 2>/dev/null && pwd -P)/$(basename "$CRAFT_REAL")"
  [ -n "$CRAFT_REPO" ] && case "$CRAFT_REAL" in
    "$CRAFT_REPO"/*|"$CRAFT_REPO") return 1 ;;
  esac
  return 0
 }
CRAFT_LOGGER=""
`
  const tryCandidate = expr => `if [ -z "\${CRAFT_LOGGER:-}" ]; then
  CRAFT_TRY=${expr}
  craft_usable "$CRAFT_TRY" && CRAFT_LOGGER="$CRAFT_TRY"
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

// The prompt that carries ONE record to disk. `command` is `write` (one-shot: detail file, verified
// readback, index line) or `finalize` (the same, plus folding in this run's phase checkpoints —
// review.js is the only engine that checkpoints). Nothing here asks the model to compute anything.
// THE STAGING FILE IS PER-RUN, AND THAT IS LOAD-BEARING. It used to be the fixed `/tmp/craft-rec.json`
// in one engine; extracting the prompt propagated that path to all four, which is three new ways to
// be wrong at once. (a) `cat >` follows a symlink, so any other local uid can pre-create that name
// pointing at a file this user owns and have the next run truncate it — an arbitrary-overwrite
// primitive on a shared or CI box, and `/tmp`'s sticky bit does not stop CREATING an entry. (b) The
// record holds every finding title, path and quoted snippet from the reviewed repo, and a default
// umask leaves it world-readable, never removed. (c) A fixed name carries no run id, while craft's
// own fan-out puts several runs in flight — rust-audit dispatches one nested review per changed crate
// through `parallel` — so between one agent's `cat >` and its own redirect another can overwrite the
// file: run A files run B's record under A's identity, the script succeeds, the readback verifies,
// `{ok:true}` comes back and NOTHING reports a loss. `mktemp` answers all three: unique name, 0600,
// created without following anything. The exit code is carried past the cleanup so a failed write
// still reports as one.
// `repo` steers the logger's `cd`, and THAT IS ALL IT STEERS. It is meaningful only for an engine
// whose review agents are pointed at the same checkout (review.js does that with REPO_DIRECTIVE);
// passed by an engine whose agents run in the session's cwd, it would file a record attributed to a
// repository the run never looked at — a lie in the one field the store is keyed by.
function logRunPrompt({ record, craftRoot = '', repo = '', command = 'write', dir = '', rejoin = false } = {}) {
  // The version comes off the RECORD rather than from a parameter of its own: it is already there,
  // and taking it from anywhere else lets the copy the logger is looked up by drift from the version
  // the record claims to be — which would file a record describing a run some other build made.
  const version = String(record?.craftVersion ?? '')
  const flags = `${dir ? `--dir ${shq(dir)} ` : ''}${!dir && rejoin ? '--rejoin ' : ''}`
  return `You are the craft observability logger. Persist ONE run record. This is mechanical IO — do not analyze, summarise, reformat or "clean up" any part of it.

Run exactly this:

\`\`\`
${loggerPrelude(craftRoot, version, repo)}CRAFT_REC="$(mktemp "\${TMPDIR:-/tmp}/craft-rec.XXXXXX")"
cat > "$CRAFT_REC" <<'CRAFT_RECORD_EOF'
…RECORD below, byte for byte…
CRAFT_RECORD_EOF
cd ${shq(repo || '.')} && node "$CRAFT_LOGGER" ${command} ${flags}--project "$PWD" < "$CRAFT_REC"; CRAFT_RC=$?; rm -f "$CRAFT_REC"; exit $CRAFT_RC
\`\`\`

The script computes every field (ts, project, commit, dirty, engineRevision, craftCommit), names the file, appends the index line and verifies the readback. You compute NONE of that. In particular: do NOT \`mkdir\` the store, do NOT run \`date\`, \`pwd\` or \`git\` yourself, and do NOT append to index.jsonl by hand.

COPY THE RECORD VERBATIM into the quoted heredoc — it can be hundreds of KB (findings, ledger, dimensions), and re-emitting it from memory silently drops the big arrays. That is exactly how a completed review once persisted \`findings: 111\` with \`dimensions: []\` and no \`verification\`, destroying the per-lens telemetry the whole store exists for.

If the script prints a line starting \`craft-log-run FAILED\`, or the command itself fails (for example the logger path does not exist), return {"ok": false, "error": "<that line, or the shell error, verbatim>"} and stop — do NOT fall back to writing the file by hand. If it succeeded, return {"ok": true} — and if it ALSO printed a line starting \`craft-log-run WARNING\`, return {"ok": true, "error": "<that line verbatim>"}: the record landed, but something about the run directory did not, and the engine has to be able to say so. Best-effort either way: never error the run over this.

RECORD:
${JSON.stringify(record, null, 2)}`
}

// Copying a large record verbatim is not a low-effort task: haiku is fine for a gate-failed stub,
// but a full review record carries every finding plus the ledger, and the cheap model is where the
// silent truncation came from. Size the model to the payload.
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

function logRunOutcome(res) {
  // A WARNING is not a loss: the record IS on disk, and only the run DIRECTORY was refused or left
  // behind. Reporting it as a lost record would send a reader hunting for a file that exists, and a
  // marker that fires on a landed write is one people stop reading. But it must not vanish either —
  // the caller gets `ok: true` with a reason to surface.
  if (res && res.ok === true) return { ok: true, reason: String((res.error || '')).trim() }
  return { ok: false, reason: (res && (res.__threw || res.error)) || 'the logger agent returned no result' }
}

// For the agent calls whose FAILURE is not the caller's problem: the run record, the phase
// checkpoints, the prior-round read. They are bookkeeping — every other agent in these engines
// produces review content, so a throw there should stop the run. These must not: the record is
// written AFTER the report already exists in memory, so losing it to a bookkeeping write would
// throw away the whole run's product.
function quietly(call) {
  return async (prompt, opts) => {
    try {
      return await call(prompt, opts)
    } catch (e) {
      return { __threw: String((e && e.message) || e) }
    }
  }
}
// <<< craft-inline

// A lost record NEVER fails the run: killing a review over a bookkeeping write would teach everyone
// to ignore the very marker this exists to raise. It is reported instead — in the notRun notes a
// human actually reads, because an empty store is otherwise indistinguishable from "never run".
const telemetryLost = []
// "lost" is asserted per line, not stamped on every line: the record landing while its run DIRECTORY
// was refused is a different fact, and calling it a lost record is the same conflation the other
// three engines dropped — the one that teaches a reader to skip the marker. A line that says the
// record itself landed keeps its own wording.
const telemetryNotes = () => telemetryLost.map(l => (
  /^the run directory \(the record itself landed\)/.test(l)
    ? `⚠️ telemetry: ${l} — the record for this run is in the store; what the directory held may not be.`
    : `⚠️ telemetry lost: ${l} — this run may be missing or incomplete in the run store. Read this verdict, not the store, for what it did.`))

const agentQuietly = quietly(agent)

async function logRun(record) {
  const res = await agentQuietly(
    logRunPrompt({ record, craftRoot: craftRootArg }),
    logRunDispatch(record, { phase: 'Coverage' }),
  )
  const landed = logRunOutcome(res)
  if (!landed.ok) {
    telemetryLost.push(`the run record — ${landed.reason}`)
    log(`⚠️ telemetry lost: the run record — ${landed.reason}`)
  }  // The record landed and the script still had something to say — a run directory refused or left
  // behind. Not a lost record, so it must not read as one, but not silence either.
  else if (landed.reason) {
    telemetryLost.push(`the run directory (the record itself landed) — ${landed.reason}`)
    log(`⚠️ telemetry: ${landed.reason}`)
  }

}
// adversarial-review uses lowercase severities internally; the store schema is capitalized.
const capSeverity = f => ({ ...f, severity: f.severity ? f.severity[0].toUpperCase() + f.severity.slice(1) : f.severity })

// ---- lens catalog ----
const LENS_BRIEF = {
  correctness: 'logic and spec conformance: does the change do what it is supposed to? Wrong behavior behind correct-looking code, off-by-one, inverted conditions, missed requirements, broken invariants.',
  security: 'security: injection, authz/authn gaps, tenant isolation breaks, secrets in code, unsafe deserialization, path traversal, SSRF, untrusted input reaching sinks.',
  money: 'money-path invariants: float arithmetic on amounts, lost cents in splits/rounding, missing idempotency on payment operations, double-charge/double-credit windows, currency mixups, ledger imbalance.',
  concurrency: 'concurrency: races on shared state, check-then-act windows, missing transactions/locks, lock ordering, blocking calls in async contexts, unbounded queues.',
  errors: 'error handling: swallowed errors, panic/crash on recoverable failures, missing rollback/cleanup on the error path, error messages leaking internals.',
  performance: 'performance: N+1 queries, work inside hot loops, unbounded memory growth, missing pagination/limits, accidental O(n^2).',
  complexity: 'complexity metrics from the codebase-memory graph (metrics-or-nothing; skipped when the repo is not indexed).',
}
const ALL_LENSES = Object.keys(LENS_BRIEF)

function finderPrompt(lens) {
  const base = diffBase ? `\`${diffBase}\`` : 'resolve it yourself: merge-base with origin/main, then main, then HEAD~1; target uncommitted changes if the tree is dirty'
  if (lens === 'complexity') {
    return `You are the complexity review lens, grounded in the codebase-memory knowledge graph.
Use ToolSearch to load the codebase-memory MCP tools (list_projects, index_status, detect_changes, search_graph, query_graph).

Step 0 — availability gate: call list_projects / index_status for this repository. If the project is NOT indexed, or the index predates the diff base, return {"findings": []} immediately. Never estimate complexity by eye; this lens is metrics-or-nothing.
Step 1: detect_changes (diff base: ${base}) to get the functions touched by the diff and their impact radius.
Step 2: for each touched function, read its complexity properties from the graph: cognitive, complexity (cyclomatic), loop_depth, transitive_loop_depth, linear_scan_in_loop, alloc_in_loop, recursion_in_loop, unguarded_recursion, param_count. One query_graph call can fetch them all.
Step 3: report ONLY findings grounded in those numbers, quoting the metric values in the description. Calibrate severity by whether THIS diff introduced or worsened the metric, not by pre-existing debt:
- diff introduces/deepens transitive_loop_depth >= 3 on a caller-reachable path -> high
- diff adds linear_scan_in_loop (hidden O(n^2)) or alloc_in_loop on a hot path -> medium..high
- diff adds unguarded_recursion or recursion_in_loop -> high
- diff sharply raises cognitive complexity of a function -> medium
- pre-existing debt merely touched by the diff -> low, mention briefly
Each finding: exact file, line, metric values, and a concrete fix (extract, hoist the scan, use a map, cap recursion).

Return {findings: []-shaped JSON}.`
  }
  return `You are the **${lens}** review lens for a diff. Review ONLY this slice; ignore everything else (other lenses cover it).

SLICE: ${LENS_BRIEF[lens]}
Diff base: ${base}.
${intentArg ? `INTENT (what the change should do): ${intentArg}` : ''}
CONTEXT EXPANSION (required): for each finding, read the surrounding code and trace callers of the changed symbols before judging — do not read the diff in isolation.
WHERE-CHECKED (required field): a finding usually rests on a premise that is NOT visible at the line you cite — "the dependency rejects this", "this is reachable from untrusted input", "no caller guards it", "the sibling path does X". Pin every such premise to a \`file:line\` you ACTUALLY OPENED, dependency sources included, and put them in \`whereChecked\`. An off-site premise you did not open is not admissible: open it, or drop the claim and report only what the cited line shows. Use "" only when the finding needs no off-site premise.
CONFIDENCE: report everything you suspect, located to file:line. Do NOT self-censor borderline findings — adversarial verification happens downstream.

Return {findings: []-shaped JSON}.`
}

// ---- throttled runner (VERBATIM mirror of lib/throttled-runner.mjs — the sandbox can't import) ----
// The runner reports its own leftovers into `notRun`; callers that report them their own way (the
// finder lenses, which mark one BLOCKING entry per dead dimension) pass `reportUnjudged: false`.
// >>> craft-inline lib/throttled-runner.mjs unjudgedNotRun makeThrottledRunner
// One not-run entry per throttled pass that ended with unfinished jobs — and NONE when the pass
// finished, which is the whole discipline: a marker that fires on healthy runs is one people stop
// reading.
// It used to claim the unjudged findings "stay Suspected". That was FALSE for an escalated finding:
// its panel members are separate jobs, so one dead lens leaves a 1-1 split that `judge` reads as a
// refutation, and refuted findings are dropped from the report entirely. The premise is now enforced
// at the judge instead of asserted here (a panel that lost a member decides nothing), and this note
// no longer promises an outcome it does not produce.
// Advisory by default, blocking when the pass judged NOTHING — the two are genuinely different: a
// gap in a panel is a weakened judgement, an empty pass is no judgement at all.
function unjudgedNotRun(tag, unfinished, { total = 0 } = {}) {
  const count = Array.isArray(unfinished) ? unfinished.length : Number(unfinished) || 0
  if (count <= 0) return []
  const key = String(tag || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'checks'
  // A pass that judged NOTHING is not an advisory footnote: no finding in it was verified at all,
  // and a verdict built on that is a verdict about nothing. It downgrades the run like a dead lens.
  const wholePass = total > 0 && count >= total
  return [{
    label: `${key}-checks-unjudged`,
    note: wholePass
      ? `the entire ${tag} pass produced no verdict (${count} check(s)) — nothing it was judging was verified`
      : `${count} ${tag} check(s) got no verdict — the findings they were judging were decided on a partial panel, or not decided at all`,
    incomplete: wholePass,
  }]
}

// Runs `jobs` in batches of `batch`, retrying whatever produced no result in quieter rounds of
// `retryBatch`, and stops spawning below the budget floor. Returns the jobs that never produced a
// result. Each job: {prompt, label, schema, effort, onResult, onMissing?}.
function makeThrottledRunner(deps) {
  const { agent, parallel, log, markNotRun, batch: BATCH, retryBatch, maxRetryRounds, budget, budgetFloor } = deps
  return async function runThrottled(jobs, tag, phaseTitle, { reportUnjudged = true } = {}) {
    let pending = jobs
    let done = 0
    let unfinished = null
    for (let round = 0; round <= maxRetryRounds && pending.length && !unfinished; round++) {
      const size = round === 0 ? BATCH : retryBatch
      if (round > 0) log(`${tag} retry round ${round}: ${pending.length} failed calls, batches of ${size}`)
      const failed = []
      for (let i = 0; i < pending.length; i += size) {
        if (budget.total && budget.remaining() < budgetFloor) {
          const skipped = pending.length - i + failed.length
          log(`Budget guard: ~${Math.round(budget.remaining() / 1000)}k tokens left -> stopping ${tag}, ${skipped} calls skipped`)
          unfinished = pending.slice(i).concat(failed)
          break
        }
        const slice = pending.slice(i, i + size)
        const res = await parallel(slice.map(j => () =>
          agent(j.prompt, { label: (round ? `retry${round}:` : '') + j.label, phase: phaseTitle, schema: j.schema, effort: j.effort })))
        res.forEach((v, k) => {
          if (v) { slice[k].onResult(v); done++ } else failed.push(slice[k])
        })
        log(`${tag}: ${done}/${jobs.length} calls done`)
      }
      if (!unfinished) pending = failed
    }
    if (!unfinished) unfinished = pending
    // A job that never produced a verdict must leave a TRACE where the verdict would have gone, not
    // only a line in the run record. Its absence is what the judge has to see: a panel silently one
    // vote short reads as a whole panel, and a 1-1 split then counts as a refutation.
    for (const j of unfinished) if (typeof j.onMissing === 'function') j.onMissing()
    // `total` lets the entry tell a gap apart from a pass that judged nothing — including the pass
    // stopped by the budget guard before it spawned its first agent, which returned an empty
    // leftover list and therefore reported as clean.
    if (reportUnjudged) for (const e of unjudgedNotRun(tag, unfinished, { total: jobs.length })) markNotRun(e.label, e.note, e.incomplete)
    return unfinished
  }
}
// <<< craft-inline

// ---- coverage honesty (VERBATIM mirror of lib/review-coverage.mjs — the sandbox can't import) ----
// Only the LANGUAGE-AGNOSTIC half is mirrored here. This engine declares no language profiles, so
// every material file is in scope for its lenses and there is no "matched no profile" gap to
// report; what it does share with review.js is the pair of guards that stop a run which looked at
// nothing from returning a bare Approve.
// >>> craft-inline lib/review-coverage.mjs noChangedFilesMessage INERT_EXT INERT_NAMES GENERATED_PATH GENERATED_FILE isInertUncovered materialUncovered nothingToReviewMessage
// A diff that came back with NO files at all. Reachable legitimately — an already-merged branch, a
// `path` scope matching nothing — and also when detection half-failed, which is why this stays
// INCOMPLETE rather than green. But it is not a coverage hole: describing it with
// noLanguageMessage(0, 0) produced "none of the 0 changed file(s) … and 0 of them went unreviewed",
// a hole of size zero, which is self-contradictory and teaches readers to ignore the marker.
function noChangedFilesMessage() {
  return `NOTHING WAS REVIEWED — the diff came back EMPTY: no changed file was detected against the resolved base. Either there is genuinely nothing to review here (an already-merged branch, or a \`path\` scope that matches nothing) or the base/scope is wrong and detection failed. No lens ran, so this is not an approval — check the base and re-run.`
}

// Which unreviewed files actually lower the claim. Derived from the path alone and deliberately
// conservative: when in doubt a file is MATERIAL. A false "material" costs one honest INCOMPLETE
// marker; a false "inert" costs a silent overclaim, which is the bug this whole section exists to
// prevent. Three narrow exemptions only — prose/asset extensions, lockfiles matched by their real
// names, and artifacts whose path makes it unambiguous that a generator wrote them.
const INERT_EXT = /\.(md|markdown|rst|adoc|svg|png|jpe?g|gif|ico|webp|pdf|woff2?|ttf|otf)$/i

const INERT_NAMES = new Set([
  'license', 'licence', 'notice', 'codeowners', '.gitignore', '.gitattributes',
  // Inert `.txt` files by NAME, not by extension. A blanket `.txt` rule was the lockfile bug again
  // in another costume: `CMakeLists.txt`, `requirements.txt`, `conanfile.txt` and `Dependencies.txt`
  // are build-system and dependency SOURCE, and a diff of nothing but those took the green
  // "nothing needed reviewing" return. When in doubt, material.
  'license.txt', 'licence.txt', 'notice.txt', 'copying.txt', 'authors.txt', 'contributors.txt',
  'changelog.txt', 'changes.txt', 'readme.txt', 'robots.txt', 'humans.txt', 'todo.txt', 'notes.txt',
  // Lockfiles, by the names they actually have. Matching a *shape* like `*lock.*` swallowed source
  // code — `db/lock.sql`, `src/lock.rs`, `internal/spin-lock.go` — and silently exempted it.
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock',
  'cargo.lock', 'flake.lock', 'poetry.lock', 'pdm.lock', 'uv.lock', 'pipfile.lock', 'gemfile.lock',
  'composer.lock', 'go.sum', 'deno.lock', 'mix.lock', 'pubspec.lock', 'podfile.lock', 'packages.lock.json',
  'gradle.lockfile', 'cabal.project.freeze', 'conan.lock', 'herd.lock',
])

// Generated artifacts. Only where the PATH itself is unambiguous — a generator-stamped suffix or a
// directory whose whole purpose is generated output. A hand-written file never lives here.
const GENERATED_PATH = /(^|\/)(__generated__|generated|node_modules|vendor)\//i

const GENERATED_FILE = /(\.snap|\.min\.(js|css|mjs|cjs)|\.pb\.(go|cc|h|rs|ts)|_pb2(_grpc)?\.py|\.gen\.(go|rs|ts)|\.generated\.[a-z0-9]+|\.g\.dart)$/i

function isInertUncovered(f) {
  const base = String(f).split('/').pop().toLowerCase()
  return INERT_EXT.test(f) || INERT_NAMES.has(base) || GENERATED_PATH.test(f) || GENERATED_FILE.test(f)
}

function materialUncovered(files) {
  return files.filter(f => !isInertUncovered(f))
}

// The other half of the no-profile case: a diff whose changed files are ALL inert (prose, assets,
// lockfiles, generated output). Nothing was reviewed AND nothing needed reviewing — a different
// statement from "files went unreviewed", and it must not be dressed up as a coverage hole. A
// marker that fires on every README-only change stops being read, which destroys the value of the
// marker on the diffs that do hide unreviewed code.
function nothingToReviewMessage(fileCount) {
  return `NOTHING NEEDED REVIEWING — all ${fileCount} changed file(s) are documentation, assets, lockfiles or generated output; none carries reviewable code. No lens ran because none had anything to look at.`
}
// <<< craft-inline

// ================= Prep: scout + index warm-up (2 agents, parallel) =================
phase('Prep')
const [scout, warmup] = await parallel([
  () => agent(
    `You are scouting a diff to plan an adversarial review. Use shell + read only — do NOT review yet.
1. Resolve the diff base. ${diffBase ? `Use \`${diffBase}\`.` : 'Try in order: `git merge-base HEAD origin/main`, `git merge-base HEAD main`, `HEAD~1`. If the tree has uncommitted changes, target those.'}
2. Inspect \`git diff --stat\` and list every touched path with \`git diff --name-only\` (same base) into changedFiles — complete and verbatim. sizeBucket: small = a few files / < ~80 changed lines; large = many files / > ~400 lines or auth/money/concurrency-heavy; medium otherwise.
3. lenses: choose from ${JSON.stringify(ALL_LENSES)}.
   - small: only the touched categories (minimum 2; always include 'correctness').
   - medium: the categories plausibly in play.
   - large: all of them.
   Decide "in play" from the diff: payments/amounts/ledger -> money; async/threads/locks/transactions -> concurrency; input parsing/auth/tenancy -> security; loops/queries -> performance; always consider 'correctness' and 'errors'. Include 'complexity' whenever the diff is medium/large (it self-skips if the repo is not indexed).`,
    { label: 'scout', schema: SCOUT_SCHEMA, model: 'haiku', effort: 'low' },
  ),
  () => agent(
    `You are warming up the codebase-memory index for a review. Use ToolSearch to load the codebase-memory MCP tools.
1. Check list_projects / index_status for this repository.
2. If the project is not indexed or the index is stale relative to the current HEAD, run index_repository with mode=fast on the repo root and wait for it.
3. Return indexed=true only if a usable index exists when you are done. If the MCP server is unavailable, return indexed=false — never error.`,
    { label: 'index-warmup', schema: WARMUP_SCHEMA, effort: 'low' },
  ),
])

const plan = {
  baseRef: scout?.baseRef ?? diffBase,
  sizeBucket: scout?.sizeBucket ?? 'medium',
  lenses: (scout?.lenses?.length ? scout.lenses.filter(l => ALL_LENSES.includes(l)) : ALL_LENSES),
}
if (!(warmup?.indexed)) {
  plan.lenses = plan.lenses.filter(l => l !== 'complexity')
  log(`codebase-memory index unavailable (${warmup?.notes ?? 'warm-up died'}) -> complexity lens dropped`)
}
log(`Scout: ${plan.sizeBucket} diff -> lenses: ${plan.lenses.join(', ')} · ${scout?.notes ?? 'scout died, running all lenses'}`)

// ---- coverage guard: a run that looked at nothing must not report a green Approve ----
// The scout enumerates the diff; three outcomes have to be told apart, and only the third is a
// review. A dead scout is NOT an empty diff — it is an unknown one, so it opens `notRun` and the
// review proceeds over all lenses rather than short-circuiting to a verdict about nothing.
// A scout that came back WITHOUT a `changedFiles` array is the dead-scout case, not the empty-diff
// one: the list is unknown, not empty. Folding it into `!scout` also keeps the `: null` below from
// reaching `!changedFiles.length`, which threw a TypeError and aborted the run before any lens ran
// and before any run record was filed — the most permissive failure there is, an invisible one.
//
// Two things are recorded per entry, and they are not the same thing.
//   `label` goes in the RUN RECORD. `lib/analyze-runs.mjs` ranks `notRun` by EXACT STRING to
//   surface fragility that REPEATS across runs, so a label must be bare and aggregatable — no
//   counts, no lens lists, no file names. A note like "3 finder lens(es) never returned:
//   correctness, concurrency" is unique to its run and fills the ranking with count-1 rows,
//   sinking the real repeats. `lens:correctness` aggregates into `3× lens:correctness`.
//   `note` is the human sentence: it goes to the log and to the returned object, where it is read
//   once, by a person, about this run.
//   `incomplete` decides whether the entry downgrades the VERDICT. Not everything recorded here is
//   a coverage hole: a single verification check with no verdict, or coverage gaps skipped at the
//   budget floor, leave their findings reported as Suspected — already the honest label — and they
//   fire on routine runs. A marker that fires on every run stops being read, which is exactly what
//   would destroy it on the runs where a dimension really did go unreviewed. So those are recorded
//   (the fragility signal is kept) but advisory; only an unreviewed dimension downgrades. This is
//   the same line `review.js` draws: dead lenses and skipped critics mark INCOMPLETE, individual
//   unverified checks do not.
const notRun = []
const markNotRun = (label, note, incomplete = true) => notRun.push({ label, note, incomplete })
const notRunLabels = () => notRun.map(e => e.label)
const notRunNotes = () => notRun.map(e => e.note)
const notRunBlocking = () => notRun.filter(e => e.incomplete)
const runThrottled = makeThrottledRunner({
  agent, parallel, log, markNotRun,
  batch: BATCH, retryBatch: RETRY_BATCH, maxRetryRounds: MAX_RETRY_ROUNDS,
  budget, budgetFloor: BUDGET_FLOOR,
})
const changedFiles = Array.isArray(scout?.changedFiles) ? scout.changedFiles.filter(f => typeof f === 'string' && f.trim()) : null
if (!scout || !changedFiles) {
  markNotRun('scout-dead', scout
    ? 'the scout returned no file list — the diff was never enumerated, so what the lenses saw is unverified'
    : 'scout died — the diff was never enumerated, so what the lenses saw is unverified')
} else if (!changedFiles.length) {
  const msg = noChangedFilesMessage()
  log(`INCOMPLETE — ${msg}`)
  await logRun({
    schemaVersion: 1, runtime: 'claude-code', craftVersion: CRAFT_VERSION, kind: 'workflow',
    name: 'adversarial-review', nested: !!viaArg, via: viaArg || null,
    verdict: 'INCOMPLETE (empty diff)', findings: summarizeFindings([]),
    scout: { size: plan.sizeBucket, lenses: [], indexed: !!(warmup?.indexed), batch: BATCH },
    dimensions: [], verification: { candidates: 0, confirmed: 0, refuteRate: 0 },
    notRun: ['empty-diff'], outputTokens: budget.spent(),
  })
  return { verdict: 'INCOMPLETE (empty diff)', confirmed: [], suspected: [], notRun: [msg].concat(telemetryNotes()), scout: { size: plan.sizeBucket, lenses: [], deadLenses: [] } }
} else if (!materialUncovered(changedFiles).length) {
  // All inert (docs/assets/lockfiles/generated). Nothing ran AND nothing needed to — an honest
  // green, deliberately not marked INCOMPLETE: a marker that fires on every README-only change
  // stops being read on the diffs that do hide unreviewed code.
  //
  // But this is the ONE exit where a green rests entirely on the scout's file list, and that list
  // comes from a model, not from `git`. A scout that truncated, globbed, or resolved the wrong base
  // and happened to emit only docs and lockfiles would approve a real code diff. The script itself
  // has no shell (the Workflow sandbox has no filesystem or Node API), so the deterministic route
  // is a second, single-purpose agent that does nothing but transcribe `git diff --name-only`. It
  // is cheap and only fires on this branch. The green is taken only if that independent list is
  // complete by its own `wc -l`, agrees with the scout's size, and is itself entirely inert;
  // anything else — including a dead cross-check — falls back to INCOMPLETE.
  //
  // The base is resolved INDEPENDENTLY, not taken from `plan.baseRef`. Pinning the cross-check to
  // the scout's own base would leave the wrong-base case structurally invisible — both agents would
  // diff the same wrong ref, agree perfectly, and the green would be granted. Resolving it again
  // from the same deterministic ladder turns a wrong base into a differing file list, which the
  // comparison below already catches. Only an explicit `diffBase` argument is passed through: there
  // the base is the caller's, not the scout's, so there is nothing to cross-check.
  //
  // What this still does NOT catch: `fileCount` and `files` come from the same model in the same
  // response, so the self-consistency arm is self-reported — a model that truncates the list AND
  // lowers its own count to match defeats it. What that arm actually rules out is the ordinary
  // failure (a list shortened while the count stays honest), not a coordinated one.
  const cross = await agent(
    `You are cross-checking a diff's file list. Run shell only — do NOT review, summarise, or judge anything.
1. Resolve the diff base YOURSELF — do not take it from anyone else. ${diffBase ? `The caller pinned it: use \`${diffBase}\`.` : 'Try in order: `git merge-base HEAD origin/main`, `git merge-base HEAD main`, `HEAD~1`. If the tree has uncommitted changes, target those.'}
2. Run \`git diff --name-only <base>\` and \`git diff --name-only <base> | wc -l\`.
3. Return every path VERBATIM in \`files\` — no truncation, no globbing, no sorting, no elision — and the \`wc -l\` number in \`fileCount\`.
4. Set ok=true ONLY if the git command succeeded and \`files\` holds every path it printed. If anything failed, or you had to shorten the list for any reason, set ok=false.`,
    { label: 'inert-crosscheck', phase: 'Prep', schema: CROSSCHECK_SCHEMA, model: 'haiku', effort: 'low' },
  )
  const crossFiles = (cross?.ok && Array.isArray(cross.files)) ? cross.files.filter(f => typeof f === 'string' && f.trim()) : null
  const agrees = !!crossFiles
    && crossFiles.length === cross.fileCount
    && crossFiles.length === changedFiles.length
    && !materialUncovered(crossFiles).length
  if (!agrees) {
    const why = !crossFiles ? 'the cross-check never returned a usable list'
      : crossFiles.length !== cross.fileCount ? `the cross-check list is incomplete (${crossFiles.length} paths vs ${cross.fileCount} reported by git)`
        : crossFiles.length !== changedFiles.length ? `git reports ${crossFiles.length} changed file(s), the scout reported ${changedFiles.length}`
          : `git's list contains reviewable code the scout did not report: ${materialUncovered(crossFiles).join(', ')}`
    const msg = `NOT REVIEWED — the scout said every changed file was inert (docs/assets/lockfiles/generated), but ${why}. The scout's file list is the only thing that green rested on, so it is not granted: no lens ran, and this is not an approval. Re-run, checking the diff base.`
    log(`INCOMPLETE — ${msg}`)
    await logRun({
      schemaVersion: 1, runtime: 'claude-code', craftVersion: CRAFT_VERSION, kind: 'workflow',
      name: 'adversarial-review', nested: !!viaArg, via: viaArg || null,
      verdict: 'INCOMPLETE (unconfirmed inert diff)', findings: summarizeFindings([]),
      scout: { size: plan.sizeBucket, lenses: [], indexed: !!(warmup?.indexed), batch: BATCH },
      dimensions: [], verification: { candidates: 0, confirmed: 0, refuteRate: 0 },
      notRun: ['inert-diff-unconfirmed'], outputTokens: budget.spent(),
    })
    return { verdict: 'INCOMPLETE (unconfirmed inert diff)', confirmed: [], suspected: [], notRun: [msg].concat(telemetryNotes()), scout: { size: plan.sizeBucket, lenses: [], deadLenses: [] } }
  }
  const msg = nothingToReviewMessage(changedFiles.length)
  log(msg)
  await logRun({
    schemaVersion: 1, runtime: 'claude-code', craftVersion: CRAFT_VERSION, kind: 'workflow',
    name: 'adversarial-review', nested: !!viaArg, via: viaArg || null,
    verdict: 'Approve', findings: summarizeFindings([]),
    scout: { size: plan.sizeBucket, lenses: [], indexed: !!(warmup?.indexed), batch: BATCH },
    dimensions: [], verification: { candidates: 0, confirmed: 0, refuteRate: 0 },
    notRun: [], outputTokens: budget.spent(),
  })
  return { verdict: 'Approve', confirmed: [], suspected: [], notRun: telemetryNotes(), summary: msg, scout: { size: plan.sizeBucket, lenses: [], deadLenses: [] } }
}

// ================= Review: throttled finder lenses =================
phase('Review')
const lensResults = new Map()
const deadLensJobs = await runThrottled(
  plan.lenses.map(lens => ({
    prompt: finderPrompt(lens),
    label: `review:${lens}`,
    schema: FINDINGS,
    effort: 'medium',
    onResult: r => lensResults.set(lens, r),
  })),
  'Review', 'Review', { reportUnjudged: false },
)
const deadLenses = deadLensJobs.map(j => j.label.replace(/^.*review:/, ''))
if (deadLenses.length) {
  log(`WARNING: finder lens(es) returned nothing: ${deadLenses.join(', ')}`)
  // One entry PER dead lens: `lens:correctness` is what aggregates across runs into
  // "3× lens:correctness", which is the whole point of ranking `notRun`.
  for (const l of deadLenses) markNotRun(`lens:${l}`, `the ${l} finder lens never returned — that dimension went unreviewed`)
}
if (plan.lenses.length && deadLenses.length === plan.lenses.length) markNotRun('all-lenses-dead', 'EVERY finder lens died — no lens looked at this diff at all')

const all = plan.lenses.flatMap(lens => {
  const r = lensResults.get(lens)
  return r ? r.findings.map(x => ({ ...x, lens })) : []
})

// ---- dedup, tier 1 (mechanical): neighbor line-buckets + title-token similarity ----
// Merging requires BOTH nearby lines (|Δ| <= 5, buckets k-1..k+1 so bucket borders don't split)
// AND similar titles — proximity alone never merges, so two distinct issues in one window
// survive as two findings. Under-merge costs one cheap verify agent; over-merge silently
// loses a finding — stay conservative.
const normTokens = t => new Set(String(t || '').toLowerCase().replace(/[^a-z0-9а-яё]+/gi, ' ').split(' ').filter(w => w.length > 2))
function titleSimilar(a, b) {
  const tokensA = normTokens(a), B = normTokens(b)
  if (!tokensA.size || !B.size) return false
  let inter = 0
  for (const w of tokensA) if (B.has(w)) inter++
  return inter / (tokensA.size + B.size - inter) > 0.5
}
const buckets = new Map()   // `${file}:${bucket}` -> entries in that bucket
const merged = []
for (const f of all) {
  const b = Math.floor(f.line / 10)
  let hit = null
  for (const nb of [b - 1, b, b + 1]) {
    for (const e of (buckets.get(`${f.file}:${nb}`) || [])) {
      if (Math.abs(e.line - f.line) <= 5 && titleSimilar(e.title, f.title)) { hit = e; break }
    }
    if (hit) break
  }
  if (hit) {
    if (!hit.sources.includes(f.lens)) hit.sources.push(f.lens)
    if (SEV_RANK[f.severity] < SEV_RANK[hit.severity]) {
      Object.assign(hit, { title: f.title, line: f.line, severity: f.severity, description: f.description, fix: f.fix, lens: f.lens })
    }
    continue
  }
  const entry = { ...f, sources: [f.lens] }
  merged.push(entry)
  const key = `${f.file}:${b}`
  if (!buckets.has(key)) buckets.set(key, [])
  buckets.get(key).push(entry)
}
let kept = merged.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity])
log(`Review: ${all.length} raw findings -> ${kept.length} after mechanical dedup`)

// ---- dedup, tier 2 (semantic, thresholded): one haiku clusterer for cross-vocabulary duplicates ----
// Catches what token overlap can't: different lenses describing one defect in different words
// ("TOCTOU at debit" vs "race on balance update"). Runs only on large pools where duplicates
// are likely; merges keep BOTH formulations so an over-eager merge degrades to a verbose
// description instead of a lost finding.
const DEDUP_THRESHOLD = 15
if (kept.length > DEDUP_THRESHOLD && (!budget.total || budget.remaining() > BUDGET_FLOOR)) {
  const CLUSTERS_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['clusters'],
    properties: {
      clusters: {
        type: 'array',
        items: { type: 'array', items: { type: 'number' }, description: 'indices of findings that are the SAME defect' },
        description: 'only groups of 2+; singletons are omitted; empty if no duplicates',
      },
    },
  }
  const clusterer = await agent(
    `You are deduplicating review findings. Below is a numbered list. Return clusters of indices that describe THE SAME underlying defect — same root cause, one fix would resolve all of them — even when phrased in different vocabulary or cited at nearby-but-different lines (e.g. a check-site vs a write-site of one race).
Merge ONLY when confident the fix is literally the same change. Two different problems in the same function are NOT a cluster. When in doubt, do not merge. Return {"clusters": []} if there are no duplicates.

FINDINGS:
${kept.map((f, i) => `${i}. [${f.severity}] ${f.title} @ ${f.file}:${f.line} (lenses: ${f.sources.join(',')}) — ${f.description}`).join('\n')}`,
    { label: 'dedup-semantic', phase: 'Review', schema: CLUSTERS_SCHEMA, model: 'haiku', effort: 'low' },
  )
  const drop = new Set()
  for (const cluster of (clusterer?.clusters ?? [])) {
    const idxs = [...new Set(cluster)]
      .filter(i => Number.isInteger(i) && i >= 0 && i < kept.length && !drop.has(i))
      .sort((x, y) => SEV_RANK[kept[x].severity] - SEV_RANK[kept[y].severity])
    if (idxs.length < 2) continue
    const head = kept[idxs[0]]
    for (const i of idxs.slice(1)) {
      const dup = kept[i]
      for (const s of dup.sources) if (!head.sources.includes(s)) head.sources.push(s)
      head.description += `\n[merged duplicate] ${dup.title} @ ${dup.file}:${dup.line}: ${dup.description}`
      drop.add(i)
    }
  }
  if (drop.size) {
    kept = kept.filter((f, i) => !drop.has(i))
    log(`Semantic dedup: merged ${drop.size} duplicate(s) -> ${kept.length} findings`)
  } else {
    log('Semantic dedup: no cross-vocabulary duplicates found')
  }
}

// ================= Verify =================
phase('Verify')
const COMBINED_INSTR = `You are an adversarial verifier. Try to REFUTE this finding. Check ALL THREE dimensions in one pass:
1. code — is the claim factually true in the code as written? Read the actual code; do not trust the description.
2. exploit — construct a concrete end-to-end scenario that triggers the issue. If you cannot, that counts against the finding.
3. severity — calibrate real impact for the multi-tenant money-path, and confirm the issue is in scope for THIS diff.
Return refuted=true if ANY dimension fails. Default to refuted=true when uncertain. Return the calibrated severity.
Also set premiseSupported: identify the ONE claim that, if false, makes the finding evaporate. If it lives outside the cited line, OPEN the finding's whereChecked location and check it actually shows that; premiseSupported=false when the premise is off-site and whereChecked is empty, points elsewhere, or merely restates the cited line. Unsupported is NOT disproven — do not raise refuted for it; the field demotes the finding on its own.`
const COMBINED_METRIC_INSTR = `You are an adversarial verifier for a METRIC-BACKED complexity finding.
Use ToolSearch to load the codebase-memory MCP tools. Check ALL THREE dimensions:
1. metric — re-read the metric values yourself via query_graph; refute if they don't match the claim or the index is unavailable.
2. attribution — confirm THIS diff introduced or worsened the metric (compare against detect_changes); pre-existing debt misattributed to the diff -> refute or downgrade.
3. severity — calibrate real impact: is the function on a hot / caller-reachable path (trace_path), or dead-end cold code?
Return refuted=true if ANY dimension fails; default to refuted=true when uncertain.
Also set premiseSupported: true when you re-read the metric values yourself and they back the claim, false when the numbers came only from the finding's own description. Unsupported is NOT disproven — it demotes the finding without marking it refuted.`
const PANEL_LENSES = [
  ['code', 'Verify ONLY the factual claim against the code as written. Read the code yourself; refute if the description misstates it.'],
  ['exploit', 'Try to construct a concrete end-to-end exploit/trigger scenario. Refute if no realistic path exists.'],
  ['severity', 'Calibrate real-world severity for the multi-tenant money-path and check the issue is in scope for this diff. Refute if severity is inflated or out of scope.'],
]

// Builds verify jobs for a set of findings, writing votes into `sink[idx]`.
// Single combined verifier (effort low) for medium/low; 3-lens panel (effort high)
// for critical/high; metric-aware single verifier for complexity findings.
function buildVerifyJobs(findings, sink) {
  const jobs = []
  findings.forEach((f, idx) => {
    const ctx = `FINDING [${f.severity}] ${f.title} @ ${f.file}:${f.line}\n` +
      `Independently reported by lenses: ${(f.sources || [f.lens]).join(', ')}\n${f.description}\nProposed fix: ${f.fix}\n` +
      `Off-site evidence claimed: ${f.whereChecked || '(none — the finding claims to be self-contained at the cited line)'}`
    const push = (lens, instr, effort, tagged) => jobs.push({
      prompt: `${instr}\n\n${ctx}`,
      label: `verify${tagged ? `[${lens}]` : ''}:${f.file}:${f.line}`,
      schema: VERDICT,
      effort,
      onResult: v => sink[idx].push({ lens, ...v }),
      // A check that never returned leaves a placeholder, so the judge can SEE the panel is short.
      // Without it a 3-lens panel that lost one member is indistinguishable from a 2-lens panel.
      onMissing: () => sink[idx].push({ lens, missing: true }),
    })
    if (f.lens === 'complexity') push('metric', COMBINED_METRIC_INSTR, 'low', true)
    else if (isEscalated(f)) for (const [lens, instr] of PANEL_LENSES) push(lens, instr, 'high', true)
    else push('combined', COMBINED_INSTR, 'low', false)
  })
  return jobs
}

// >>> craft-inline lib/adversarial-judge.mjs usableVote judgeVotes
// A verdict object we cannot read is not a verdict. `onResult` spreads whatever the agent returned
// (`{...true}` and `{...{}}` both yield an object with none of the fields), and this engine already
// records a live agent returning WITHOUT a schema-`required` field — so `required` in the schema is
// not a guarantee. Unread fields would otherwise vote: a missing `refuted` counts as non-refuting, a
// missing `premiseSupported` as non-supporting, and an `undefined` severity survives into the median
// where `SEV_RANK[undefined]` makes the comparator NaN and the confirmed finding can come out with no
// severity at all — which `baseVerdict` reads as neither critical nor high, i.e. Approve.
function usableVote(v, SEV_RANK) {
  return !!v && typeof v === 'object'
    && typeof v.refuted === 'boolean'
    && typeof v.premiseSupported === 'boolean'
    && (v.severity === 'not-an-issue' || SEV_RANK[v.severity] != null)
}

function judgeVotes(findings, sink, SEV_RANK) {

  // Severity is the THIRD decision axis, and the one that produces the verdict: `baseVerdict` reads
  // Block from a confirmed critical/high, Warning from a medium, Approve otherwise. So the absent
  // vote must be asked the same question here as on the other two — and it was not, which is how a
  // dead lens turned Block into Approve while both other axes agreed and nothing was flagged.
  // The median is taken over the FULL panel: a panel of three whose members voted [high, low] and
  // lost one has median index 1 of TWO, i.e. the milder — absence pulling severity down.
  const ranks = Object.keys(SEV_RANK).sort((a, b) => SEV_RANK[a] - SEV_RANK[b])
  const MOST = ranks[0]
  const LEAST = ranks[ranks.length - 1]
  // Which side of the verdict this severity falls on. Comparing TIERS, not severities, keeps the
  // marker narrow: critical vs high both mean Block, and flagging that as undecided would fire on
  // runs where the absence changed nothing — a false INCOMPLETE is no safer here than a false clean.
  const tierOf = sev => (SEV_RANK[sev] <= SEV_RANK.high ? 'block' : sev === 'medium' ? 'warning' : 'approve')
  const calibrateWith = (f, votes, missing, pad) => {
    const sevs = votes.filter(v => !v.refuted && v.severity !== 'not-an-issue')
      .map(v => v.severity)
      .concat(Array.from({ length: missing }, () => pad))
      .sort((a, b) => SEV_RANK[a] - SEV_RANK[b])
    return sevs.length ? sevs[Math.floor(sevs.length / 2)] : f.severity
  }
  // The absent votes padded with what the FINDER claimed — a neutral stand-in, where their silence
  // was not. Only used once the two extremes agree that the verdict cannot swing either way.
  const calibrate = (f, votes, missing) => calibrateWith(f, votes, missing, f.severity)
  const judged = findings.map((f, idx) => {
    // Malformed votes become absences, so the two-assignment machinery below decides them rather than
    // letting an unreadable object count as a non-refuting, non-supporting, severity-less confirmation.
    const all = (sink[idx] || []).map(v => (v && !v.missing && usableVote(v, SEV_RANK)) ? v : { lens: v && v.lens, missing: true })
    // A missing vote must not decide — but "missing" is not the same as "undecidable". Ask what the
    // absent votes COULD have changed, and only fall back when they could have changed the answer.
    // Both traps are real and both were measured on this engine:
    //   [refute, confirm, confirm] confirms; losing one confirming lens made `refutes * 2 < votes`
    //     false, so the SAME finding was filed as refuted — and refuted findings never reach the
    //     report, they are fed forward as "adversarially disproven, do not re-report".
    //   Demoting on ANY absence is the inverse trap: [confirm, confirm, missing] cannot change —
    //     even a refuting third vote leaves 1*2 < 3 — so demoting it to Suspected drops a critical
    //     finding out of `confirmed`, and the verdict is built from `confirmed` alone. A silent
    //     Approve, in place of the Block that two independent lenses had earned.
    const missing = all.filter(v => v.missing).length
    const votes = all.filter(v => !v.missing)
    const refutes = votes.filter(v => v.refuted).length
    // The two extreme assignments of the absent votes. They agree → the absence changes nothing and
    // the answer stands; they disagree → the absent vote is the deciding one, and nobody cast it.
    const survivesIfAbsentRefute = votes.length > 0 && (refutes + missing) * 2 < all.length
    const survivesIfAbsentConfirm = votes.length > 0 && refutes * 2 < all.length
    const refuteUndecided = survivesIfAbsentRefute !== survivesIfAbsentConfirm
    const survives = !refuteUndecided && survivesIfAbsentRefute
    // An off-site premise no verifier could pin to real code is UNSUPPORTED, not disproven. It costs
    // the finding its Confirmed tier, but it must NOT be filed as refuted: the refuted list is fed
    // back to the next round as "adversarially disproven — do not re-report", which would bury a
    // possibly-real finding for the rest of the run over a missing citation.
    // The SAME two-assignment question is asked here. Resolving the absence pessimistically on this
    // axis ("assume the missing vote did not support") looks conservative and is not: it drops the
    // finding out of `confirmed`, the verdict is built from `confirmed` alone, and the run prints a
    // bare Approve — a missing vote deciding a critical finding, in the permissive direction, which
    // is the whole defect. `premiseSupported` is a required verifier field and a 1-1 split on a
    // 3-lens panel is an ordinary outcome, not a corner case.
    const supported = votes.filter(v => v.premiseSupported).length
    const unsupportedIfAbsentUnsupported = supported * 2 <= all.length
    const unsupportedIfAbsentSupported = (supported + missing) * 2 <= all.length
    const premiseUndecided = survives && unsupportedIfAbsentUnsupported !== unsupportedIfAbsentSupported
    const premiseUnsupported = survives && !premiseUndecided && unsupportedIfAbsentUnsupported
    const severityUndecided = survives && !premiseUnsupported && missing > 0
      && tierOf(calibrateWith(f, votes, missing, MOST)) !== tierOf(calibrateWith(f, votes, missing, LEAST))
    const undecided = refuteUndecided || premiseUndecided || severityUndecided
    const confirmed = survives && !premiseUnsupported && !premiseUndecided && !severityUndecided
    // `undecidedByAbsence` is the honest label for "nobody decided this": it is what a caller must
    // surface in the VERDICT, because a finding parked in Suspected does not downgrade anything.
    // What the run would have printed had the absent votes come back at their worst. The caller must
    // gate its blocking entry on THIS, not on the finder's own label: the finder's severity and lens
    // are what shaped the panel, not what the verdict would have been. A single verifier can calibrate
    // a `medium` finding up to `critical`, and a `high` complexity finding gets one verifier and no
    // panel — both are "nobody decided this, and deciding it would have blocked the run".
    const undecidedByAbsence = missing > 0 && (undecided || votes.length === 0)
    const reachable = votes.length ? calibrateWith(f, votes, missing, MOST) : MOST
    // Only meaningful on a finding nobody decided: on a decided one the answer is the answer.
    const couldHaveBlocked = undecidedByAbsence && tierOf(reachable) === 'block'
    return { ...f, confirmed, premiseUnsupported, couldHaveBlocked, undecidedByAbsence, votes, severity: confirmed ? calibrate(f, votes, missing) : f.severity }
  })
  return {
    confirmed: judged.filter(v => v.confirmed),
    // `degraded` is excluded here for the same reason `premiseUnsupported` is: the refuted list is
    // fed forward as "do NOT re-report — adversarially disproven", and a panel that never finished
    // disproved nothing. It falls to Suspected, which is what the not-run note has always claimed.
    refuted: judged.filter(v => !v.confirmed && !v.premiseUnsupported && !v.undecidedByAbsence && v.votes.length > 0),
    suspected: judged.filter(v => v.undecidedByAbsence || v.votes.length === 0 || v.premiseUnsupported),
  }
}
// <<< craft-inline
const judge = (findings, sink) => judgeVotes(findings, sink, SEV_RANK)

const votes = kept.map(() => [])
const verifyJobs = buildVerifyJobs(kept, votes)
log(`Verify plan: ${kept.length} findings -> ${verifyJobs.length} checks (${kept.filter(isEscalated).length} escalated to 3-lens panel), throttled to ${BATCH} concurrent`)
// `runThrottled` records the unjudged checks in `notRun` itself (advisory) — see the region above.
const unverifiedJobs = await runThrottled(verifyJobs, 'Verify', 'Verify')
if (unverifiedJobs.length) log(`WARNING: ${unverifiedJobs.length} checks got no verdict after retries`)

let { confirmed, refuted, suspected } = judge(kept, votes)
log(`Verify done: ${confirmed.length} confirmed, ${refuted.length} refuted, ${suspected.length} suspected (no verdict)`)
// A finding nobody decided must reach the VERDICT, not only the Suspected list. Suspected downgrades
// nothing — `baseVerdict` is computed from `confirmed` alone — so a run in which every escalated
// finding lost the one panel member that would have decided it prints a bare `Approve`, identical to
// a run whose panels all voted and cleared them. Blocking, and narrow: it needs an escalated
// (critical/high) finding whose absent vote was the deciding one, which is the exact case where the
// engine cannot say whether this run should have blocked.
// Gated on what the absent vote could have DECIDED, never on the finder's label. `isEscalated` reads
// the finder's severity and lens — the fields that shaped the panel — and both of its clauses leak
// here: a complexity finding is excluded by lens although the lens emits `high` and gets a single
// verifier, and a `medium` finding is excluded by severity although one verifier can calibrate it to
// `critical`. The judge computes the reachable tier instead.
const undecidedEscalated = [...confirmed, ...refuted, ...suspected].filter(f => f.undecidedByAbsence && f.couldHaveBlocked)
if (undecidedEscalated.length) {
  markNotRun('escalated-findings-undecided', `${undecidedEscalated.length} critical/high finding(s) lost the panel vote that would have decided them — this run cannot say whether it should have blocked`)
}

// ================= Coverage: critic, then verify its gaps through the same pipeline =================
phase('Coverage')
const CRITIC_PROMPT = `You are a completeness critic for an adversarial diff review (diff base: ${plan.baseRef || 'HEAD'}).
Ask: what is MISSING — a changed file no finding touched, a category of bug not checked, a dimension left uncovered?
Report each gap as a concrete located finding (file:line of the suspicious spot, severity, description, fix).
CONFIRMED findings (do not repeat them): ${JSON.stringify(confirmed.map(f => `${f.title} @ ${f.file}:${f.line}`))}
REFUTED claims (do NOT re-report these — they were adversarially disproven): ${JSON.stringify(refuted.map(f => `${f.title} @ ${f.file}:${f.line}`))}
Dead lenses this run (their dimension is UNCOVERED — look there first): ${JSON.stringify(deadLenses)}
If coverage is complete, return {"findings": []}.`
let critic = await agent(CRITIC_PROMPT, { label: 'coverage-critic', phase: 'Coverage', schema: FINDINGS, effort: 'high' })
if (!critic) {
  log('Coverage critic failed, retrying once')
  critic = await agent(CRITIC_PROMPT, { label: 'coverage-critic-retry', phase: 'Coverage', schema: FINDINGS, effort: 'high' })
}
if (!critic) {
  // Without this the critic's silence is indistinguishable from "coverage is complete": `?? []`
  // below yields zero gaps, and a diff whose blind spots were never looked for reads as covered.
  log('WARNING: coverage critic died twice — completeness was never checked')
  markNotRun('coverage-critic-dead', 'the coverage critic died twice — no completeness check ran, so blind spots in this review are unknown')
}

// Critic findings do not bypass verification — they ride the same throttled pipeline.
const gaps = (critic?.findings ?? []).map(f => ({ ...f, lens: 'coverage', sources: ['coverage'] }))
let refutedGaps = 0
if (gaps.length && (!budget.total || budget.remaining() > BUDGET_FLOOR)) {
  log(`Coverage critic raised ${gaps.length} gap(s) -> verifying through the same pipeline`)
  const gapVotes = gaps.map(() => [])
  // Opts out of the runner's advisory entry and marks its own BLOCKING one, for the reason the
  // else-branch below spells out: a coverage gap is the critic's claim that something went
  // UNREVIEWED. Crossing the budget floor midway through this pass leaves exactly the same blind
  // spots unopened as failing to start it, so the two must land on the same side of the line —
  // otherwise the identical run reads `Approve` or `Approve (INCOMPLETE)` depending only on which
  // side of the first batch the floor happened to fall. Same label, so analyze-runs aggregates both.
  const unverifiedGapJobs = await runThrottled(buildVerifyJobs(gaps, gapVotes), 'Coverage-verify', 'Coverage', { reportUnjudged: false })
  if (unverifiedGapJobs.length) {
    log(`WARNING: ${unverifiedGapJobs.length} coverage-gap checks got no verdict`)
    markNotRun('coverage-gaps-unverified', `${unverifiedGapJobs.length} coverage-gap check(s) got no verdict — the blind spots they name went unopened`)
  }
  const g = judge(gaps, gapVotes)
  confirmed = confirmed.concat(g.confirmed)
  suspected = suspected.concat(g.suspected)
  refutedGaps = g.refuted.length
  log(`Coverage gaps: +${g.confirmed.length} confirmed · +${g.suspected.length} suspected · ${g.refuted.length} refuted`)
} else if (gaps.length) {
  log(`Budget too low to verify ${gaps.length} coverage gap(s) -> reported as suspected`)
  // Blocking, unlike `verify-checks-unjudged`, and the difference is epistemic rather than a matter
  // of degree. An unjudged *finding* is a claim that something is wrong; reporting it as Suspected
  // is already the honest answer, and the review still looked. A coverage gap is the critic's claim
  // that something went UNREVIEWED — the same category as a dead lens, which downgrades. Leaving it
  // advisory would let a plain `Approve` stand on a run whose named blind spots nobody opened.
  // It does not fire on routine runs: it needs the budget floor reached AND gaps raised.
  markNotRun('coverage-gaps-unverified', `${gaps.length} coverage gap(s) were never verified (budget floor reached) — they are reported as Suspected, and the blind spots they name went unopened`)
  suspected = suspected.concat(gaps.map(f => ({ ...f, confirmed: false, votes: [] })))
}

// A verdict must never claim more coverage than the run had: a dimension that went unreviewed
// downgrades the verdict, so a run where the work died cannot read exactly like a clean one. The
// advisory entries (see `markNotRun`) are recorded and printed but do NOT downgrade — their
// findings are already reported as Suspected, and a marker that fires on routine runs stops being
// read on the runs that need it.
const baseVerdict = confirmed.some(f => f.severity === 'critical' || f.severity === 'high') ? 'Block'
  : confirmed.some(f => f.severity === 'medium') ? 'Warning' : 'Approve'
const verdict = notRunBlocking().length ? `${baseVerdict} (INCOMPLETE)` : baseVerdict
log(`Verdict: ${verdict} — ${confirmed.length} confirmed, ${suspected.length} suspected`)
for (const e of notRun) log(`${e.incomplete ? 'NOT RUN' : 'PARTIAL'}: ${e.note}`)

// ---- run record ----
const candidates = kept.length + gaps.length
const refutedTotal = refuted.length + refutedGaps
await logRun({
  schemaVersion: 1,
  runtime: 'claude-code',
  craftVersion: CRAFT_VERSION,
  kind: 'workflow',
  name: 'adversarial-review',
  nested: !!viaArg,
  via: viaArg || null,
  verdict,
  findings: summarizeFindings(confirmed.concat(suspected).map(capSeverity)),
  scout: { size: plan.sizeBucket, lenses: plan.lenses, indexed: !!(warmup?.indexed), batch: BATCH },
  dimensions: plan.lenses.map(l => {
    const s = summarizeFindings(confirmed.filter(f => (f.sources || []).includes(l)).map(capSeverity))
    return { dimension: l, verdict: '', findingCount: s.total, bySeverity: s.bySeverity }
  }),
  verification: { candidates, confirmed: confirmed.length, refuteRate: candidates ? Math.round((refutedTotal / candidates) * 100) / 100 : 0 },
  notRun: notRunLabels(),
  outputTokens: budget.spent(),
})

return {
  verdict,
  confirmed: confirmed.map(({ votes: v, ...f }) => ({ ...f, votes: v.length, refutes: v.filter(x => x.refuted).length })),
  suspected: suspected.map(({ votes: v, ...f }) => f),
  notRun: notRunNotes().concat(telemetryNotes()),
  scout: { size: plan.sizeBucket, lenses: plan.lenses, deadLenses },
}
