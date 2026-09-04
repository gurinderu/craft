export const meta = {
  name: 'triage-findings',
  description: 'Triage review findings (craft agents + GitHub PR comments) into one ordered, validated fix plan — no edits',
  whenToUse: 'After a review or rust-audit produces many findings, or a PR has many inline comments, and you want them validated against the code, deduped, conflict-checked, and turned into an ordered fix plan.',
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

// One arg path, not two. The second one used to re-parse the raw string after normalizeArgs had
// already refused it, so a value reported as "ALL options ignored" was quietly reinstated a line
// later — a loud drop undone in silence, which is worse than either behaviour alone.
const argv = A

const pr = argv.pr ? String(argv.pr) : ''
const report = argv.report ? String(argv.report) : ''
const base = argv.base ? String(argv.base) : ''
const priorLedger = Array.isArray(argv.priorLedger) ? argv.priorLedger : []
// The repo being triaged, when it is NOT the directory the session runs in, and where craft itself
// lives so the logger can find lib/craft-log-run.mjs. As an installed plugin CLAUDE_PLUGIN_ROOT is
// set for us; launched by scriptPath from a checkout it is NOT, and the fallback would resolve
// against the triaged repo — where the script is not. Pass craftRoot then.
const craftRootArg = argv.craftRoot ? String(argv.craftRoot) : ''

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

// The craft release that produced a run. Recorded on the run record and index line so an
// aggregate can be filtered to ONE engine version: without it, runs from every rubric the store
// has ever seen blend together. MUST match `.claude-plugin/plugin.json` — `lib/check-workflows.mjs`
// fails the build if it drifts. Kept OUTSIDE the craft-inline fence below, whose contents are
// byte-compared against lib/run-record.mjs.
const CRAFT_VERSION = '0.18.0' // x-release-please-version

// ---- run-record helpers (VERBATIM mirror of lib/run-record.mjs — the sandbox can't import; keep in sync) ----
// >>> craft-inline lib/run-record.mjs SEVERITIES countBySeverity summarizeFindings tallyVerdicts
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

function tallyVerdicts(entries) {
  const t = { accept: 0, reject: 0, defer: 0, 'needs-decision': 0, conflict: 0 }
  for (const e of (Array.isArray(entries) ? entries : [])) {
    if (e && Object.prototype.hasOwnProperty.call(t, e.verdict)) t[e.verdict] += 1
  }
  return t
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
function loggerPrelude(craftRoot, version = '') {
  if (craftRoot) return `CRAFT_LOGGER=${shq(craftRoot)}/lib/craft-log-run.mjs\n`
  // Neither an explicit root nor the env var: look for THIS engine's own installed copy before
  // giving up. Measured, not assumed — an installed plugin ran with CLAUDE_PLUGIN_ROOT unset in the
  // logger agent's shell, so the abort below fired on every run and the store gained nothing at all,
  // invisibly: it stays full of older runs, so neither the file count nor the index shows the hole.
  //
  // The search is deliberately narrow. It looks ONLY under the user's own plugin cache, and only for
  // the exact version this engine is stamped with, so a 0.18.1 engine can never pick up a 0.16.0
  // script and file records that misdescribe what ran. It never looks at the reviewed repository —
  // that repo is untrusted by construction, and resolving there would execute its code with the
  // user's privileges, which is the hole the removed `:-.` fallback used to open.
  // The env var WINS when it resolves: the search is a fallback, not an override. Written the other
  // way round first, the loop overwrote a perfectly good path from CLAUDE_PLUGIN_ROOT with whatever
  // the cache happened to hold — a launch from a checkout would have silently logged through some
  // other installed version.
  // ONE candidate, and it is version-pinned. The marketplace directory was a second candidate for
  // exactly one commit, and it was wrong in the way this pin exists to prevent: it is a git clone
  // tracking the marketplace, not a versioned release, so a machine whose clone had moved on would
  // have executed a NEWER script — which stamps engineRevision and craftCommit from its own build —
  // while the record body said this version. A record misdescribing which engine ran is worse than
  // no record, because it is counted.
  //
  // `$CLAUDE_CONFIG_DIR` is honoured because a session configured that way keeps its plugins
  // elsewhere entirely, and hardcoding `~/.claude` would leave that user with the defect unfixed and
  // no sign of it.
  //
  // The layout being relied on here belongs to the harness, not to craft (realm @nick/craft, node
  // #48, observed rather than documented). It can move without notice, which is why a miss is
  // ordinary rather than exceptional: not found means the loud refusal below, never a guess.
  const search = version
    ? `if [ ! -f "\${CRAFT_LOGGER:-}" ]; then
  CRAFT_CFG="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  CRAFT_CAND="$CRAFT_CFG/plugins/cache/craft/craft/${shq(version).slice(1, -1)}/lib/craft-log-run.mjs"
  [ -f "$CRAFT_CAND" ] && CRAFT_LOGGER="$CRAFT_CAND"
fi
`
    : ''
  return `CRAFT_LOGGER="\${CLAUDE_PLUGIN_ROOT:-}"
[ -n "$CRAFT_LOGGER" ] && CRAFT_LOGGER="$CRAFT_LOGGER/lib/craft-log-run.mjs"
${search}[ -f "\${CRAFT_LOGGER:-}" ] || { echo "craft-log-run FAILED: no logger found — craftRoot unset, CLAUDE_PLUGIN_ROOT unset, and no installed copy of ${version || 'this version'} under the plugin cache; refusing to resolve against the reviewed repository"; exit 1; }
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
${loggerPrelude(craftRoot, version)}CRAFT_REC="$(mktemp "\${TMPDIR:-/tmp}/craft-rec.XXXXXX")"
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
// The banner that leads the plan when a write did not land — the same one review.js uses.
// >>> craft-inline lib/review-coverage.mjs telemetryLostSection
// ---- telemetry honesty ----
// A run record is written by an agent shelling out to lib/craft-log-run.mjs, so the write can fail
// while the review itself is perfectly healthy: a craftRoot that has moved, a dead logger agent, a
// damaged store. Losing it used to be pure silence, and silence in the store is read as "this review
// was never run" — the permissive default wearing the face of a fact.
// The recorded decision is that this NEVER fails the run (a three-hour review killed by a bookkeeping
// write teaches everyone to ignore the marker); it is reported instead. Returns '' for a healthy run,
// so the marker cannot appear where nothing was lost — a marker that fires on healthy runs is one
// people stop reading, which is the same defect wearing the opposite sign.
// The body speaks about the WRITE, never about the run: it goes on every exit, including those whose
// verdict says nothing was reviewed (dead base resolution, unknown language pin, empty diff), where
// reassurance that "the review ran" would contradict the verdict itself. And it says "could not be
// confirmed", not "did not land": two of the three ways an entry gets here — an abandoned deadline
// (the logger agent is NOT cancelled and may still write) and a malformed reply — are compatible with
// a write that succeeded. Certainty we do not have is the same defect with the sign flipped.
// It LEADS the report rather than trailing it: a consumer that truncates (rust-audit clips an
// embedded review report to 4000 chars) would cut a tail marker off, leaving the silence intact.
// Each line ends up at the head of a human-facing report, and its text is model-authored (a logger
// agent quotes back what the script printed). Flattened and bounded so a reply cannot forge report
// structure — a heading, a verdict line — above the verdict the engine actually computed.
function telemetryLostSection(lost) {
  const lines = (Array.isArray(lost) ? lost : []).filter(l => String(l ?? '').trim())
  if (!lines.length) return ''
  // A record that LANDED while its run directory did not is a different fact from a record nobody
  // can find, and counting it under "could not be confirmed" is how a banner earns its way onto the
  // list of things readers skip. The two are counted separately and the heading follows whichever is
  // actually true — the section is still one section, because both mean the store is not the whole
  // story for this run.
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
const telemetryLost = []
const agentQuietly = quietly(agent)

async function logRun(record) {
  const res = await agentQuietly(
    logRunPrompt({ record, craftRoot: craftRootArg }),
    logRunDispatch(record, { phase: 'Plan' }),
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

// ---- Gather --------------------------------------------------------------
phase('Gather')
if (!pr && !report) {
  throw new Error('triage-findings needs a source: pass args.pr (GitHub PR number) and/or args.report (path to a rust-audit report).')
}

const gatherTasks = []
const requestedLocators = []   // parallel to gatherTasks; drives NOT-RUN bookkeeping for the run record
if (report) {
  requestedLocators.push('report')
  gatherTasks.push(() => agent(
    `Read the review report at \`${report}\`. Extract every finding into the schema. Set source to "rust-audit" (or "rust-reviewer" for a single reviewer verdict). Copy severity/title/location/detail verbatim; leave proposed_fix and thread_id empty unless present.`,
    { label: 'gather:report', phase: 'Gather', schema: RAW_SCHEMA },
  ))
}
if (pr) {
  requestedLocators.push('pr')
  gatherTasks.push(() => agent(
    `Gather inline review comments from GitHub PR #${pr}. Resolve the repo with \`gh repo view --json owner,name\`, then \`gh api repos/{owner}/{repo}/pulls/${pr}/comments --paginate\`. For each UNRESOLVED, non-outdated review comment make one finding: title = short summary, location = \`<path>:<line>\` (path + line/original_line), detail = the comment body, thread_id = the comment/thread id, severity = your best estimate (Critical|High|Medium|Low|Info), proposed_fix = empty. Set source = "github-pr".`,
    { label: 'gather:pr', phase: 'Gather', schema: RAW_SCHEMA },
  ))
}

const gatherResults = await parallel(gatherTasks)   // order preserved → align with requestedLocators
const notRunSources = requestedLocators.filter((_, i) => !gatherResults[i])
if (notRunSources.length) log(`WARNING: source(s) that produced nothing: ${notRunSources.join(', ')} — the triage covers fewer sources than asked.`)
const gathered = gatherResults.filter(Boolean)
const raw = gathered.flatMap(g => (Array.isArray(g.findings) ? g.findings : []).map(f => ({ ...f, source: g.source })))
log(`Gathered ${raw.length} raw finding(s) from ${gathered.length} source(s).`)

// stable composite id; reused for dedup, ledger, and idempotent re-runs
const idOf = f => `${f.source}::${f.location || 'no-loc'}::${f.title}`
const priorById = new Map(priorLedger.map(e => [e.stable_id, e]))

// ---- Validate ------------------------------------------------------------
phase('Validate')
const pin = base
  ? `Validate against ref \`${base}\` (the ref the findings were generated against), not the live working tree.`
  : 'Validate against the currently checked-out tree.'

// The sentinel that marks a `needs-decision` nothing actually judged. It rides in the ledger entry's
// `reason` (a carry-forward prefixes that reason, so `includes` is the test, not equality) and it
// is what keeps such an entry OUT of the carry-forward set on the next run.
const UNJUDGED_MARKER = 'NOT JUDGED'

const deadValidations = []
const validations = (await parallel(raw.map(f => () => {
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
  return agent(
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
  ).then(v => {
    // A dead validator used to be dropped by `filter(Boolean)`, which removed the finding from the
    // plan AND from the ledger: a Critical whose judge died did not appear as unjudged, it appeared
    // as nothing. It is unjudged, so it becomes the verdict that already means "a human must look
    // at this" — the one downstream vocabulary (carry-forward, prompt, ledger) already understands.
    if (v) return v
    deadValidations.push(id)
    return { stable_id: id, verdict: 'needs-decision', reason: `${UNJUDGED_MARKER} — the validator agent died; this finding was never checked against the code`, fix_pointer: '', premise_checked: '(validator died — nothing was opened)' }
  })
}))).filter(Boolean)

const accepted = validations.filter(v => v.verdict === 'accept')
log(`Validated ${validations.length}: ${accepted.length} accept, ${validations.length - accepted.length} other.`)
if (deadValidations.length) log(`WARNING: ${deadValidations.length} validator(s) died -> carried as needs-decision (unjudged), not dropped.`)

// ---- Plan ----------------------------------------------------------------
phase('Plan')
// Re-attach each accepted validation's raw finding so the planner has location/detail.
const rawById = new Map(raw.map(f => [idOf(f), f]))
const acceptedEnriched = accepted.map(v => ({ ...v, finding: rawById.get(v.stable_id) || null }))

const plan = await agent(
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
)

// ---- Observability: persist a run record (best-effort) -------------------
// Prefer the plan's ledger (it carries the cross-finding `conflict` disposition); fall back to the
// solo validations when the Plan phase produced nothing.
let ledger = (plan && Array.isArray(plan.ledger)) ? plan.ledger : validations

// The prompt above ASKS the plan agent to copy the marker verbatim; asking is not a guarantee. A
// summarising model paraphrases a one-line free-text reason as a matter of course, and the marker
// is the ONLY thing that tells the next run this finding was never judged: lose it and the finding
// reads as settled forever — exactly the bug this marker exists to prevent, returning silently on
// run three. So the script re-injects it deterministically. `validations` is the local record of
// what each finding's verdict actually was, so a marked reason is restored (and a dropped entry
// re-added) regardless of what the agent returned. The prompt instruction stays as belt and braces.
if (ledger !== validations) {
  const unjudged = new Map(validations.filter(v => String(v.reason || '').includes(UNJUDGED_MARKER)).map(v => [v.stable_id, v]))
  if (unjudged.size) {
    const seen = new Set()
    ledger = ledger.map(e => {
      const v = e && unjudged.get(e.stable_id)
      if (!v) return e
      seen.add(e.stable_id)
      return String(e.reason || '').includes(UNJUDGED_MARKER) ? e : { ...e, verdict: v.verdict, reason: v.reason }
    })
    for (const [id, v] of unjudged) if (!seen.has(id)) ledger.push({ stable_id: id, verdict: v.verdict, reason: v.reason })
    plan.ledger = ledger
  }
}
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
