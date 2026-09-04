export const meta = {
  name: 'rust-audit',
  description: 'Full Rust crate audit — per-crate review, inter-crate contracts, architecture, crate decomposition, security, Miri, semver, build-matrix, deps, unused-crate detection (verified), and test/doc health in parallel, synthesized into one report',
  whenToUse: 'Before a release or a big merge, when you want the comprehensive full review — every craft dimension run at once and consolidated into a single verdict. Pass {base} to fix the diff base; {mutants:true} to include the slow mutation pass.',
  phases: [
    { title: 'Scout', detail: 'detect the diff base, unsafe code, and the workspace crates + dependency edges', model: 'haiku' },
    { title: 'Audit', detail: 'parallel per-crate review + per-edge contracts + architecture + crate-decomposition + security + Miri + semver/build-matrix/deps/unused-crates/tests-cov' },
    { title: 'Verify', detail: 'adversarially verify unused-crate candidates before reporting' },
    { title: 'Synthesize', detail: 'merge every dimension into one severity-ranked report' },
  ],
}

// Optional args: {base: "origin/main"} fixes the diff base; {mutants: true} opts into the slow
// mutation-testing pass in the tests-cov dimension.
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

const baseArg = A.base ? String(A.base) : ''
const runMutants = !!A.mutants
// The repo under audit, when it is NOT the directory the session runs in, and where craft itself
// lives so the logger can find lib/craft-log-run.mjs. As an installed plugin CLAUDE_PLUGIN_ROOT is
// set for us; launched by scriptPath from a checkout it is NOT, and the fallback would resolve
// against the audited repo — where the script is not. Pass craftRoot then.
const craftRootArg = A.craftRoot ? String(A.craftRoot) : ''

const CRATE_ITEM = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'path'],
  properties: {
    name: { type: 'string', description: 'crate (package) name' },
    path: { type: 'string', description: "crate directory (its manifest dir), relative to the repo root" },
  },
}

const EDGE_ITEM = {
  type: 'object',
  additionalProperties: false,
  required: ['from', 'to'],
  properties: {
    from: { type: 'string', description: 'caller crate name (depends on `to`)' },
    to: { type: 'string', description: 'callee crate name' },
  },
}

const SCOUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['hasDiff', 'hasUnsafe', 'baseRef', 'crates', 'changedCrates', 'edges', 'notes'],
  properties: {
    hasDiff: { type: 'boolean', description: 'true if any .rs files differ vs the base ref (committed or uncommitted)' },
    hasUnsafe: { type: 'boolean', description: 'true if the workspace contains any `unsafe` block or impl' },
    baseRef: { type: 'string', description: 'the git ref the diff was computed against, or empty if none resolved' },
    crates: { type: 'array', items: CRATE_ITEM, description: 'workspace members; empty if cargo metadata is unavailable' },
    changedCrates: { type: 'array', items: CRATE_ITEM, description: 'subset of crates with a changed .rs file vs the base; empty if no base / no changes' },
    edges: { type: 'array', items: EDGE_ITEM, description: 'intra-workspace dependency edges; empty if cargo metadata is unavailable' },
    notes: { type: 'string', description: 'one line on what was detected' },
  },
}

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['dimension', 'verdict', 'summary', 'findings'],
  properties: {
    dimension: { type: 'string', description: 'dimension label, e.g. review:<crate> | contract:<from>→<to> | architecture | security | miri | crate-decomposition | semver | build-matrix | deps | unused-crates | tests-cov' },
    // ENUM, not a description. The aggregate below is deliberately non-permissive — anything it
    // cannot read as green becomes a Warning — and that rule is only honest where the vocabulary is
    // actually constrained. With a bare `{type:'string'}` an agent answering "No UB detected" or
    // "OK" flipped a fully green audit to Warning. Constrain the vocabulary where it is PRODUCED;
    // normalizeDimensionVerdict() catches whatever still slips through.
    //
    // `INCOMPLETE (not run)` is the third outcome, and the reason it exists: an Approve is a claim
    // about what was NOT found, and it only holds over what was actually looked at. A dimension
    // whose tool is absent looked at nothing, so it must say so — worstVerdict() and
    // normalizeDimensionVerdict() both read INCOMPLETE as non-green, and auditVerdict() marks the
    // whole audit INCOMPLETE from it.
    verdict: {
      type: 'string',
      enum: ['Approve', 'Warning', 'Block', 'Healthy', 'Concerns', 'At-risk', 'Clean', 'UB-found', 'INCOMPLETE (not run)'],
      description: 'Approve/Warning/Block, Healthy/Concerns/At-risk, or Clean/UB-found — use one of these words exactly. Use "INCOMPLETE (not run)" when the tooling this dimension depends on was absent, so nothing was actually checked: a dimension that could not run is NOT an Approve.',
    },
    summary: { type: 'string', description: 'one-paragraph bottom line' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'title', 'location', 'detail'],
        properties: {
          severity: { type: 'string', description: 'Critical | High | Medium | Low | Info' },
          title: { type: 'string' },
          location: { type: 'string', description: 'file:line or crate/module, empty if not applicable' },
          detail: { type: 'string', description: 'what is wrong and the direction of the fix' },
        },
      },
    },
  },
}

// Verdict for one unused-crate candidate. The verifier's job is to REFUTE (prove the crate IS
// used); confirmedUnused=true means it survived that and is safe to remove.
const UNUSED_VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['confirmedUnused', 'evidence', 'removal'],
  properties: {
    confirmedUnused: { type: 'boolean', description: 'true ONLY if genuinely unused after trying to refute; default false when uncertain' },
    evidence: { type: 'string', description: 'what was checked — use sites, cfg/feature gates, macros, re-exports, build.rs, dev/bench/example usage, bin/published status' },
    removal: { type: 'string', description: 'concrete removal direction if confirmed unused; empty otherwise' },
  },
}

// The craft release that produced a run. Recorded on the run record and index line so an
// aggregate can be filtered to ONE engine version: without it, runs from every rubric the store
// has ever seen blend together. MUST match `.claude-plugin/plugin.json` — `lib/check-workflows.mjs`
// fails the build if it drifts. Kept OUTSIDE the craft-inline fence below, whose contents are
// byte-compared against lib/run-record.mjs.
const CRAFT_VERSION = '0.18.0' // x-release-please-version

// ---- run-record helpers (VERBATIM mirror of lib/run-record.mjs — the sandbox can't import; keep in sync) ----
// >>> craft-inline lib/run-record.mjs SEVERITIES countBySeverity summarizeFindings worstVerdict
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

// An UNRECOGNISED verdict must never default to the most permissive outcome: an aggregate that
// turns `INCOMPLETE (no language profile)` back into `Approve` re-creates, one layer up, exactly the
// overclaim the leaf verdicts were fixed to avoid. Anything that is not a verdict we can read as
// green — INCOMPLETE included — aggregates to Warning.
function worstVerdict(verdicts) {
  const vs = (Array.isArray(verdicts) ? verdicts : []).map(v => String(v || ''))
  // ZERO verdicts is not unanimous green — it is the ABSENCE of any evidence: every dimension died,
  // or nothing ran at all. Returning Approve here renders a total outage as a pass, the same
  // overclaim in its purest form. An empty set aggregates to INCOMPLETE, which no consumer reads
  // as green.
  if (!vs.length) return 'INCOMPLETE (no verdicts)'
  if (vs.some(v => /Block|At-risk|UB-found/i.test(v))) return 'Block'
  if (vs.some(v => /Warning|Concerns/i.test(v))) return 'Warning'
  if (vs.some(v => /INCOMPLETE/i.test(v) || !/Approve|Healthy|Clean|Pass/i.test(v))) return 'Warning'
  return 'Approve'
}
// <<< craft-inline

// The unused-crates find→verify pipeline's bookkeeping. Extracted to lib/ because its interesting
// cases are the DEATH paths — a verifier that resolves null, one that throws, most of a fan-out
// dying — and nothing in this sandbox can exercise them; lib/audit-verification.test.mjs does, and
// the craft-inline gate pastes the tested source back in here.
// >>> craft-inline lib/audit-verification.mjs wrapVerdict VERIFY_MIN_JUDGED tallyVerification verificationIncomplete unusedCratesResult
// A verifier that DIED and a verifier that REFUTED both leave a candidate unconfirmed, and folding
// them together is the failure this module exists to prevent: a refutation is a judgement somebody
// made, a death is a hole where no judgement happened.
//
// The load-bearing detail: `agent()` RESOLVES to null when the subagent dies on a terminal API
// error or is skipped (it only throws on budget exhaustion) — the same contract `safeAgent` tests
// with `if (res != null)`. So a bare `.then(v => ({ c, v }))` wraps a death into a TRUTHY object,
// `filter(Boolean)` drops nothing, and every dead verifier is silently counted as a refutation.
// Wrapping through here keeps the null a null all the way to the tally.
function wrapVerdict(c, v) {
  return v == null ? null : { c, v }
}

// Fraction of candidates that must have been JUDGED (confirmed or refuted) for the dimension to
// claim it verified anything. Below it the surface is mostly unexamined and the dimension reports
// INCOMPLETE rather than a green.
//
// Why a fraction rather than "any death at all": one flaky agent in a large fan-out is the ordinary
// weather of this engine, and a marker that fires on every run stops being read. Why not the old
// "only when EVERY verifier died": 3 deaths out of 4 is not one flaky agent, and the audit table
// rendered that run as a green dimension over a surface nobody looked at. Half is the line: at or
// above it a majority of the candidates carry a real judgement, below it the summary would be
// speaking mostly about candidates nothing was established for.
const VERIFY_MIN_JUDGED = 0.5

// Split the settled verifier results into judgements and holes. `verdicts` is what `parallel()`
// returns for the per-candidate thunks: `{ c, v }` for a verifier that answered, null for one that
// died (resolved-null, kept null by wrapVerdict; or threw, which parallel() turns into null).
function tallyVerification(candidates, verdicts) {
  const list = Array.isArray(candidates) ? candidates : []
  const alive = (Array.isArray(verdicts) ? verdicts : []).filter(Boolean)
  const confirmedItems = alive.filter(x => x && x.v && x.v.confirmedUnused)
  const judged = alive.length
  const died = list.length - judged
  return {
    candidates: list.length,
    judged,
    judgedItems: alive,
    died: died > 0 ? died : 0,
    confirmedItems,
    confirmed: confirmedItems.length,
    refuted: judged - confirmedItems.length,
    // Rate over what was actually JUDGED — never over the candidate count, which would charge the
    // deaths to the detector as if they had been refutations. Null when nothing was judged: there
    // is no rate, and 0 would read as "this lens refutes nothing".
    refuteRate: judged ? Math.round(((judged - confirmedItems.length) / judged) * 100) / 100 : null,
  }
}

// True when too few candidates were judged for the dimension's verdict to mean anything.
function verificationIncomplete(t) {
  return t.candidates > 0 && t.judged < Math.ceil(t.candidates * VERIFY_MIN_JUDGED)
}

// The whole `unused-crates` dimension result, verdict included, derived from the candidates and the
// settled verifier results. `_verification` is the internal tally the run record projects.
function unusedCratesResult(candidates, verdicts) {
  const t = tallyVerification(candidates, verdicts)
  const _verification = { candidates: t.candidates, confirmed: t.confirmed, refuted: t.refuted, died: t.died, judged: t.judged, refuteRate: t.refuteRate }
  const diedNote = t.died ? ` ${t.died} verifier(s) died — those candidates are UNVERIFIED, neither confirmed nor cleared.` : ''
  const confirmed = t.confirmedItems.map(x => ({
    severity: 'Medium',
    title: x.c.title,
    location: x.c.location || '',
    detail: `${x.v.evidence || ''}${x.v.removal ? `\nRemove: ${x.v.removal}` : ''}`.trim() || (x.c.detail || ''),
  }))
  if (verificationIncomplete(t)) {
    const unjudged = (Array.isArray(candidates) ? candidates : [])
      .filter(c => !t.judgedItems.some(x => x.c === c))
      .map(c => ({ severity: 'Info', title: `unverified: ${c.title}`, location: c.location || '', detail: `${c.detail || ''}\nVerification did not run for this candidate — it is neither confirmed unused nor cleared.`.trim() }))
    return {
      dimension: 'unused-crates',
      verdict: 'INCOMPLETE (not run)',
      // Say what WAS established before saying what was not. An INCOMPLETE that omits the confirmed
      // hits reads as "nothing came of this", and a summary-only reader then misses a real finding
      // that is sitting in `findings` right below. And no "most": at 9 judged of 20 the unjudged
      // share is under half, so the word would be false — give the counts and let them speak.
      summary: t.judged
        ? `${t.candidates} candidate(s) flagged; ${t.judged} judged (${t.confirmed} verified unused, ${t.refuted} refuted), ${t.died} verifier(s) died. ${t.candidates - t.judged} candidate(s) are UNVERIFIED — neither confirmed nor cleared.`
        : `${t.candidates} candidate(s) flagged, but every verifier failed to return — none was confirmed OR refuted. The unused-crate surface is UNVERIFIED, not clean.`,
      findings: confirmed.concat(unjudged),
      _verification,
    }
  }
  return {
    dimension: 'unused-crates',
    verdict: confirmed.length ? 'Warning' : 'Approve',
    summary: `${t.candidates} candidate(s) flagged; ${t.confirmed} verified unused after trying to refute each; ${t.refuted} refuted (kept).${diedNote}`,
    findings: confirmed.length ? confirmed : [{ severity: 'Info', title: 'No verified unused crates', location: '', detail: `${t.candidates} candidate(s) flagged, ${t.refuted} refuted by verification.${diedNote}` }],
    _verification,
  }
}
// <<< craft-inline

// Free text in, vocabulary out. worstVerdict() treats anything it cannot read as green as a Warning
// — the right default over a CONSTRAINED vocabulary, and a false alarm over free text: "No UB
// detected", "OK" and "No issues" are green answers to the miri prompt's "Clean / UB-found" and used
// to flip a whole green audit to Warning. The schema now pins the vocabulary; this maps the answers
// that still arrive off-vocabulary onto it. Anything genuinely unrecognisable is returned UNCHANGED,
// so it still lands in the non-permissive branch of worstVerdict — this widens the green vocabulary,
// it never weakens the default.
const GREEN_VERDICT = /^(approve[ds]?|healthy|clean|pass(ed|ing)?|ok(ay)?|fine|good|green|no ub( (detected|found))?|no (issues|findings|problems|defects)( (detected|found))?|none( found)?|nothing (found|to report)|all (clear|good))[\s.!—–-]*$/i
function normalizeDimensionVerdict(v) {
  const t = String(v == null ? '' : v).trim()
  if (!t) return t
  if (/INCOMPLETE/i.test(t)) return t
  // Green FIRST, and only on a WHOLE-string match: "No UB found" is a clean miri answer, while the
  // red pattern's `ub[- ]found` would otherwise read it as a Block. Requiring the whole string keeps
  // "OK, but 2 blocking findings" out of the green branch — it falls through to the red test below.
  if (GREEN_VERDICT.test(t)) return 'Approve'
  if (/\b(block(ing|ed)?|at[- ]risk|ub[- ]found|found ub|fail(ed|ure|ing)?|critical)\b/i.test(t)) return 'Block'
  if (/\b(warn(ing)?s?|concerns?|caution)\b/i.test(t)) return 'Warning'
  return t
}

// The audit verdict carries an (INCOMPLETE) marker when any dimension failed to run OR could not
// run (its tooling was absent, so it checked nothing) — unless the aggregate is already an
// INCOMPLETE verdict in its own right.
function auditVerdict(worst, notRun) {
  if (!notRun.length || /INCOMPLETE/i.test(worst)) return worst
  return `${worst} (INCOMPLETE)`
}

// Drop internal (`_`-prefixed) keys so they never leak into the synthesis prompt.
function stripInternal(obj) {
  const out = {}
  for (const k of Object.keys(obj)) if (!k.startsWith('_')) out[k] = obj[k]
  return out
}
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
// The banner that leads the report when a write did not land — the same one review.js uses.
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

// A lost record NEVER fails the audit: killing it over a bookkeeping write would teach everyone to
// ignore the very marker this exists to raise. It is reported instead, at the head of the report a
// human actually reads — an empty store is otherwise indistinguishable from "never run".
const telemetryLost = []
const agentQuietly = quietly(agent)

async function logRun(record) {
  const res = await agentQuietly(
    logRunPrompt({ record, craftRoot: craftRootArg }),
    logRunDispatch(record, { phase: 'Synthesize' }),
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

// Plugin agent types (craft:*) are frequently absent from the workflow sandbox's registry. Dispatch
// to the requested agentType, but on an "agent type '<x>' not found" throw — or a null on runtimes
// that signal a missing type that way — fall back to the generic subagent (the briefs are
// self-contained) and REMEMBER the miss so later dimensions skip straight to generic instead of
// re-failing. Without this, the contract/architecture/security/miri dimensions silently become
// NOT RUN whenever the craft agents aren't registered.
const agentTypeMissing = new Set()
async function safeAgent(prompt, opts = {}) {
  const at = opts.agentType
  const generic = { ...opts }
  delete generic.agentType
  if (!at || agentTypeMissing.has(at)) return agent(prompt, generic)
  try {
    const res = await agent(prompt, opts)
    if (res != null) return res
    return await agent(prompt, generic)   // null: try generic once; don't memoize (may be transient)
  } catch (e) {
    if (!/not found/i.test(String((e && e.message) || e))) throw e
    agentTypeMissing.add(at)
    log(`⚠️ agent type '${at}' not registered here — falling back to the generic subagent for the rest of this audit`)
    return agent(prompt, generic)
  }
}

phase('Scout')
const scout = await agent(
  `You are scouting a Rust workspace to plan an audit. Use shell commands only — do NOT review anything yet.

1. Determine the diff base. ${baseArg
    ? `Use \`${baseArg}\` as the base ref.`
    : 'Try in order until one resolves: `git merge-base HEAD origin/main`, `git merge-base HEAD main`, `HEAD~1`.'}
2. hasDiff = true if \`git diff --name-only <base>...HEAD\` lists any \`.rs\` file, OR \`git status --porcelain\` shows uncommitted \`.rs\` changes.
3. hasUnsafe = true if \`grep -rnE "\\bunsafe\\b" --include=*.rs .\` finds any match (a rough check is fine; ignore obvious comment-only hits if cheap to do).
4. baseRef = the ref you actually used (empty string if none resolved).
5. crates = workspace members from \`cargo metadata --no-deps --format-version 1\` — each as {name, path} where path is the crate's manifest directory relative to the repo root. Empty array if \`cargo metadata\` is unavailable.
6. changedCrates = the subset of \`crates\` whose directory contains a \`.rs\` file listed by \`git diff --name-only <base>...HEAD\` (or \`git status --porcelain\` for uncommitted work). Empty if no base or no changed \`.rs\`.
7. edges = intra-workspace dependency edges from \`cargo metadata --format-version 1\`: {from, to} where BOTH \`from\` and \`to\` are workspace members and \`from\` depends on \`to\`. Empty array if \`cargo metadata\` is unavailable.`,
  // Scout is pure mechanics (git refs + grep) — run it cheap: Haiku at low effort.
  { label: 'scout', schema: SCOUT_SCHEMA, model: 'haiku', effort: 'low' },
)
// scout is null if the agent was skipped or died — fall back to safe defaults rather than crash.
const baseRef = scout?.baseRef ?? ''
const hasUnsafe = scout?.hasUnsafe ?? true // fail-safe: run Miri when detection didn't resolve
const crates = Array.isArray(scout?.crates) ? scout.crates : []
const changedCrates = Array.isArray(scout?.changedCrates) ? scout.changedCrates : []
const edges = Array.isArray(scout?.edges) ? scout.edges : []
log(scout?.notes ?? 'scout produced no result — assuming unsafe present, no base ref')

phase('Audit')

// Map a rust-review workflow report string into a FINDINGS_SCHEMA-shaped dimension result.
// A review report has a stable shape: a `## Verdict` heading whose first non-empty following line
// IS the verdict. Classify on that line alone — the body legitimately contains ⚠️ and the word
// INCOMPLETE (the "Not reviewed" list, "Coverage gaps"), so a substring match over the whole report
// scored a plain Approve as a Warning and any mention of the word as uncovered. A report with no
// `## Verdict` heading is one we cannot read, and the non-permissive default applies.
function verdictLine(report) {
  const text = String(report || '')
  const m = /^[ \t]*#{1,6}[ \t]*Verdict\b(.*)$/im.exec(text)
  if (!m) return null
  // The verdict is sometimes written INLINE on the heading (`## Verdict: ⛔ Block — 2 High`). Reading
  // past the heading line then landed on the NEXT heading, which matches nothing, so a Block was
  // reported as "verdict could not be read" and downgraded to Warning. When the heading line itself
  // carries text after `Verdict`, that text IS the verdict; only otherwise look below it.
  const inline = String(m[1] || '').replace(/^[\s:：—–-]+/, '').trim()
  if (inline) return inline
  for (const line of text.slice(m.index + m[0].length).split('\n')) {
    const t = line.trim()
    if (t) return t
  }
  return null
}

function reviewResult(dimension, report) {
  const line = verdictLine(report)
  // SEVERITY FIRST, then coverage — the same rule lib/analyze-runs.mjs states and implements for the
  // run store, and the two must not disagree. A `⛔ Block (INCOMPLETE)` is a block: partial coverage
  // cannot un-find a finding that was already made, so it must not be downgraded to Warning. Only an
  // otherwise-green verdict is voided by incompleteness, because an Approve is a claim about what was
  // NOT found and holds only over what was actually looked at. Anything unreadable is Warning.
  const verdict = line == null ? 'Warning'
    : /⛔|Block/.test(line) ? 'Block'
      : /⚠️|Warning/.test(line) ? 'Warning'
        : /INCOMPLETE/i.test(line) ? 'Warning'
          : /✅|Approve/.test(line) ? 'Approve' : 'Warning'
  // The summary must follow the SAME classification as the verdict. A bare INCOMPLETE test here
  // described a `⛔ Block (INCOMPLETE)` as "uncovered, not clean" — one dimension reported both as a
  // Block and as a mere absence of coverage. Severity first here too: a Block is a Block, and the
  // partial coverage is a clause on it, never a replacement for it.
  const incomplete = /INCOMPLETE/i.test(line || '')
  const summary = line == null
    ? 'Deep review verdict could not be read — this dimension is unverified, not clean.'
    : verdict === 'Block'
      ? `Deep review returned a BLOCK — blocking findings below${incomplete ? '; coverage was also partial, so there may be more' : ''}.`
      : incomplete
        ? 'Deep review did NOT run to completion — this dimension is uncovered, not clean.'
        : 'Elastic deep review — see findings below.'
  return {
    dimension,
    verdict,
    summary,
    findings: [{ severity: 'Info', title: 'Deep review report', location: '', detail: String(report || 'no report').slice(0, 4000) }],
  }
}

// Dimensions are assembled dynamically; `dispatched` records one label per thunk and drives the
// NOT-RUN bookkeeping (a thunk that returns null is flagged NOT RUN).
const tasks = []
const dispatched = []

// Review dimension — per-crate fan-out (feature A). changedCrates → diff-scoped; no base → all
// crates; 0 or 1 crate → today's single whole-workspace review.
const reviewCrates = changedCrates.length ? changedCrates : (baseRef ? [] : crates)
if (reviewCrates.length > 1) {
  for (const c of reviewCrates) {
    tasks.push(() => workflow('review', { base: baseRef, path: c.path, languages: ['rust'], _via: 'rust-audit', ...(craftRootArg ? { craftRoot: craftRootArg } : {}) })
      .then(report => reviewResult(`review:${c.name}`, report))
      .catch(() => null))
    dispatched.push(`review:${c.name}`)
  }
} else {
  // Without craftRoot the child resolves its logger from CLAUDE_PLUGIN_ROOT alone and, in a checkout
  // launch, cannot log at all — every nested record lost while the parent's lands.
  tasks.push(() => workflow('review', baseRef ? { base: baseRef, languages: ['rust'], _via: 'rust-audit', ...(craftRootArg ? { craftRoot: craftRootArg } : {}) }
                                              : { languages: ['rust'], _via: 'rust-audit', ...(craftRootArg ? { craftRoot: craftRootArg } : {}) })
    .then(report => reviewResult('review', report))
    .catch(() => null))
  dispatched.push('review')
}

// Contracts dimension (feature B) — one focused review per TOUCHED intra-workspace edge. An edge
// is touched when its caller or callee is a changed crate; with no base, every edge is touched.
const changedNames = new Set(changedCrates.map(c => c.name))
const touchedEdges = edges.filter(e => !baseRef || changedNames.has(e.from) || changedNames.has(e.to))
if (touchedEdges.length) {
  // The agent `label` uses an ASCII `->` (display-safe); the `dimension` and the matching
  // `dispatched` entry use the Unicode `→` (U+2192). Keep those two in sync — the NOT-RUN
  // bookkeeping compares `dispatched` against `dimension`; do NOT "unify" them to the label's `->`.
  for (const e of touchedEdges) {
    tasks.push(() => safeAgent(
      `Review the call contract on the workspace dependency edge \`${e.from}\` → \`${e.to}\`: does \`${e.from}\` use \`${e.to}\`'s PUBLIC API the way its contract intends? Check signatures and types at the boundary, error and panic contracts, documented invariants and trait laws, and the semver/breaking-change compatibility of \`${e.to}\`'s public surface against \`${e.from}\`'s usage. Load the rust-review skill (the api-design pass), rust-errors (error contracts), and rust-traits (trait laws) for the rubric. Return a verdict and findings.\n\nObservability: the rust-audit workflow records this run — do NOT write your own record.`,
      { label: `contract:${e.from}->${e.to}`, agentType: 'craft:rust-reviewer', phase: 'Audit', schema: FINDINGS_SCHEMA, model: 'opus' },
    ).then(r => (r ? { ...r, dimension: `contract:${e.from}→${e.to}` } : null)))
    dispatched.push(`contract:${e.from}→${e.to}`)
  }
} else {
  log('No intra-workspace dependency edges to review — skipping the contracts dimension.')
}

// Crate-decomposition dimension (feature C) — whole-project; runs even on a single crate.
tasks.push(() => agent(
  `Judge this Rust workspace's crate boundaries and recommend where code should be EXTRACTED into its own crate, or where an over-split crate should be MERGED back. Load the rust-ecosystem skill and its crate-extraction.md rubric, and build on the workspace dependency graph (\`cargo metadata\`). For EACH recommendation give: the DRIVER (reuse / compile parallelism / dependency inversion / trust boundary / independent semver / test isolation / god-crate split — or, for a merge, "single consumer, no boundary reason"), the BOUNDARY (which module or code), and the HOW. Recommend only — do NOT move code. Return a verdict (Healthy / Concerns / At-risk) and findings.`,
  { label: 'crate-decomposition', phase: 'Audit', schema: FINDINGS_SCHEMA, effort: 'medium' },
).then(r => (r ? { ...r, dimension: 'crate-decomposition' } : null)))
dispatched.push('crate-decomposition')

tasks.push(() => safeAgent(
  `Audit the architecture of this whole Rust project against the rust-architecture-review rubric (load the rust-architecture-review skill). Build the crate/module dependency graph and judge the structure in BOTH directions — too little (layer leaks, god modules) and too much (ghost abstractions, over-layering). Return your health rating and findings. If NO dependency graph could be built at all (cargo metadata/tree failed, cargo-modules absent, and no manifest or source structure was readable), nothing was judged: return verdict "INCOMPLETE (not run)" naming what was missing — not "Healthy". A graph built from the source fallback IS a graph: rate it normally.\n\nObservability: the rust-audit workflow records this run — do NOT write your own record.`,
  { label: 'architecture', agentType: 'craft:rust-architecture-reviewer', phase: 'Audit', schema: FINDINGS_SCHEMA },
).then(r => (r ? { ...r, dimension: 'architecture' } : null)))
dispatched.push('architecture')

tasks.push(() => safeAgent(
  `Run the Rust security toolchain (cargo-audit, cargo-deny, cargo-geiger, semgrep — whatever is available) against the rust-security rubric (load the rust-security skill). Consolidate into a severity-ranked verdict and findings. If NONE of the tools is installed, so nothing was actually scanned, return verdict "INCOMPLETE (not run)" and name the missing tools — a scan that ran nothing is not an Approve.\n\nObservability: the rust-audit workflow records this run — do NOT write your own record.`,
  { label: 'security', agentType: 'craft:rust-security-scanner', phase: 'Audit', schema: FINDINGS_SCHEMA, model: 'opus' },
).then(r => (r ? { ...r, dimension: 'security' } : null)))
dispatched.push('security')

if (hasUnsafe) {
  tasks.push(() => safeAgent(
    `This workspace contains unsafe code. Run its tests under Miri and report any undefined behavior against the rust-unsafe rubric (load the rust-unsafe skill). Return a verdict (Clean / UB-found), or "INCOMPLETE (not run)" if the nightly toolchain or miri itself is unavailable so nothing was executed under Miri — an unrun Miri is NOT Clean. Return findings.\n\nObservability: the rust-audit workflow records this run — do NOT write your own record.`,
    { label: 'miri', agentType: 'craft:rust-miri', phase: 'Audit', schema: FINDINGS_SCHEMA, model: 'opus' },
  ).then(r => (r ? { ...r, dimension: 'miri' } : null)))
  dispatched.push('miri')
} else {
  log('No unsafe code detected — skipping Miri.')
}

// ---- Whole-project tool dimensions (D–G). Each runs its tools, interprets, and degrades
// gracefully: a missing tool/toolchain is a SKIP, never a hard failure — but a skip reports
// `INCOMPLETE (not run)`, not Approve. Approve stays reserved for "the tool ran and found
// nothing"; a reader of the dimension table must be able to tell those two apart. ----

tasks.push(() => agent(
  `Check public-API semver compatibility across the workspace's PUBLISHED crates. Run \`cargo semver-checks check-release\` (per published crate as needed). If \`cargo-semver-checks\` is not installed, say so and return verdict "INCOMPLETE (not run)" with a one-line note naming what was missing — do NOT fail, and do NOT return Approve: nothing was checked. If the tool IS available but there is no published library crate to check, that is a real, complete answer — return "Approve" with a note that the workspace publishes no library. Load the rust-ecosystem skill (semver/publishing) and the rust-review api-design pass. Report breaking changes vs the published baseline as findings.`,
  { label: 'semver', phase: 'Audit', schema: FINDINGS_SCHEMA, effort: 'low' },
).then(r => (r ? { ...r, dimension: 'semver' } : null)))
dispatched.push('semver')

tasks.push(() => agent(
  `Check the build across feature combinations and the MSRV. If \`cargo-hack\` is installed: \`cargo hack check --feature-powerset --no-dev-deps\`, plus \`cargo check --no-default-features\` and \`cargo check --all-features\`. For MSRV: read \`rust-version\` from Cargo.toml and run \`cargo hack --rust-version check\` (or \`cargo +<rust-version> check\` if that toolchain is installed). Skip any tool/toolchain that is absent with a note. If NOTHING could run, return verdict "INCOMPLETE (not run)" naming what was missing — do NOT fail, and do NOT return Approve: no feature combination was actually built. Return "Approve" only if at least one check ran and passed. Load the rust-ecosystem skill. Report failing feature combinations or MSRV breakage as findings.`,
  { label: 'build-matrix', phase: 'Audit', schema: FINDINGS_SCHEMA, effort: 'low' },
).then(r => (r ? { ...r, dimension: 'build-matrix' } : null)))
dispatched.push('build-matrix')

tasks.push(() => agent(
  `Audit dependency HYGIENE (distinct from security vulns/licenses). Run \`cargo tree -d\` (duplicate/conflicting versions that bloat the build and binary) and \`cargo outdated\` (out-of-date deps). Do NOT check unused dependencies here — the \`unused-crates\` dimension owns that (with verification). Skip any tool that is not installed with a note — do NOT fail; but if NEITHER tool is installed, so no dependency hygiene was actually inspected, return verdict "INCOMPLETE (not run)" naming the missing tools rather than "Approve". Load the rust-ecosystem skill (dependency weight/hygiene). Report duplicates and notably out-of-date deps as findings.`,
  { label: 'deps', phase: 'Audit', schema: FINDINGS_SCHEMA, effort: 'low' },
).then(r => (r ? { ...r, dimension: 'deps' } : null)))
dispatched.push('deps')

// Unused-crates dimension — detect, then ADVERSARIALLY VERIFY, two classes of dead weight:
//   (a) orphan workspace members — a workspace crate no other member depends on, that is not a
//       binary and not a published library;
//   (b) unused dependencies — deps declared in a Cargo.toml but never used (cargo machete/udeps).
// Both detectors are false-positive-prone (cfg/feature-gated, macro-only, re-exported, build.rs,
// dev/bench/example-only usage), so every candidate is verified before it reaches the report: a
// verifier tries HARD to prove the crate IS used and only the survivors are kept. Self-contained
// find→verify pipeline inside one thunk so it composes with the flat `parallel(tasks)` fan-out.
tasks.push(async () => {
  const found = await agent(
    `Find UNUSED crates in this Rust workspace, in two classes:
(a) ORPHAN workspace members — from \`cargo metadata --format-version 1\`, workspace members that NO other workspace member depends on (any dependency kind), EXCLUDING binaries (a [[bin]] target or src/main.rs) and published libraries (Cargo.toml \`publish\` is not false / it is meant for crates.io).
(b) UNUSED dependencies — run \`cargo machete\` (or \`cargo +nightly udeps\` if machete is absent) to list dependencies declared in a Cargo.toml but not used.
Skip a tool that is not installed with a note — do NOT fail. \`cargo metadata\` alone answers class (a), so it is enough to run: if the graph loads and there are no orphan members, that is a real "Approve" with an empty findings list. But if \`cargo metadata\` itself does not run, so NOTHING was inspected, return verdict "INCOMPLETE (not run)" naming what was missing — not "Approve".
Load the rust-ecosystem skill (dependency / crate hygiene).
These are CANDIDATES, not confirmed — they will be verified downstream. Return one finding per candidate: title = "orphan-member: <crate>" or "unused-dep: <dep> in <crate>", location = the owning manifest path, detail = why the graph/tool thinks it is unused. Use severity Info (verification sets the real severity).`,
    { label: 'unused-crates:find', phase: 'Audit', schema: FINDINGS_SCHEMA, effort: 'low' },
  )
  if (!found) return null
  const candidates = (Array.isArray(found.findings) ? found.findings : [])
    .filter(f => /^(orphan-member|unused-dep):/.test(f.title || ''))
  if (!candidates.length) return { ...found, dimension: 'unused-crates', _verification: { candidates: 0, confirmed: 0, refuted: 0, died: 0, judged: 0, refuteRate: null } }
  // Verify each candidate: prove it is USED. Default to "used" (drop it) when uncertain —
  // recommending deletion of live code is the costly error here.
  const verdicts = await parallel(candidates.map((c, i) => () =>
    agent(
      `A detector flagged a crate/dependency as UNUSED. Try HARD to REFUTE that — prove it IS used — before accepting it. Candidate: ${JSON.stringify(c)}.
Check the usages machete/udeps and the dependency graph miss: \`use\`/path references; cfg-gated and feature-gated usage; macro-only and re-exported (\`pub use\`) usage; build.rs / [build-dependencies]; [dev-dependencies] exercised only in tests, benches, or examples; and for an orphan member whether it is actually a bin, an example/bench/xtask, or consumed/published outside this workspace. Grep the source to confirm.
Set confirmedUnused=true ONLY if it is genuinely unused and safe to remove; default to false when uncertain.`,
      { label: `unused-crates:verify#${i + 1}`, phase: 'Verify', schema: UNUSED_VERDICT_SCHEMA, model: 'opus' },
    ).then(v => wrapVerdict(c, v)),
  ))
  return unusedCratesResult(candidates, verdicts)
})
dispatched.push('unused-crates')

tasks.push(() => agent(
  `Assess test effectiveness and docs. Run \`cargo llvm-cov --summary-only\` (overall coverage + worst-covered files) if \`cargo-llvm-cov\` is installed.${runMutants ? ' Run \`cargo mutants --timeout 60\`, time-boxed, to surface weak spots (it is slow).' : ' Do NOT run cargo mutants (not requested via {mutants:true}).'} Build docs cleanly: \`cargo doc --no-deps\` (flag broken intra-doc links) and run doctests (\`cargo test --doc\`). Skip any tool that is not installed with a note — do NOT fail; but if NONE of them ran (no coverage tool, no doc build, no doctests), return verdict "INCOMPLETE (not run)" naming the missing tools rather than "Approve" — nothing was measured. Load the rust-testing skill (coverage/mutation/doctests) and rust-idioms (rustdoc). Report low-coverage hotspots, surviving mutants, broken doc links, and failing doctests as findings.`,
  { label: 'tests-cov', phase: 'Audit', schema: FINDINGS_SCHEMA, effort: 'low' },
).then(r => (r ? { ...r, dimension: 'tests-cov' } : null)))
dispatched.push('tests-cov')

// Normalise every dimension verdict ONCE, here, so the aggregate, the persisted record and the
// synthesis prompt all read the same vocabulary (reviewResult already normalised its own).
const results = (await parallel(tasks)).filter(Boolean).map(r => ({ ...r, verdict: normalizeDimensionVerdict(r.verdict) }))

// Two ways a dimension can fail to produce an answer, and BOTH have to reach the report:
//   NOT RUN      — a dispatched dimension that produced no result at all (its agent failed).
//   COULD NOT RUN — the agent came back, but the tooling it depends on was absent, so it checked
//                   nothing and said so with the `INCOMPLETE (not run)` verdict.
// The second case used to be spelled `Approve` on the tool dimensions
// (semver/build-matrix/deps/unused-crates/tests-cov, plus security and Miri), which printed
// `semver | Approve` for a semver check that never happened and left the audit looking complete.
// An Approve is a claim about what was NOT found and only holds over what was looked at; a tool
// that never ran looked at nothing. Both lists mark the audit INCOMPLETE.
// Two intentional skips avoid NOT-RUN by never being pushed to `dispatched`: contracts (no touched
// edges) and Miri (no unsafe) — those are genuine "nothing to check here", not "could not check".
const ran = new Set(results.map(r => r.dimension))
const notRun = dispatched.filter(d => !ran.has(d))
// ANCHORED: only a verdict that is NOTHING BUT incomplete means "checked nothing". A severity-
// suffixed one (`Block (INCOMPLETE)` from a partially-covered nested review) is a real finding
// with partial coverage — worstVerdict() keeps it red; it does not belong in this list.
const couldNotRun = results.filter(r => /^\s*INCOMPLETE/i.test(String(r.verdict || ''))).map(r => r.dimension)
const incompleteDimensions = [...notRun, ...couldNotRun]
if (notRun.length) log(`No result from: ${notRun.join(', ')} — flagged NOT RUN in the report.`)
if (couldNotRun.length) log(`Tooling absent, nothing checked: ${couldNotRun.join(', ')} — flagged COULD NOT RUN in the report.`)

const stripped = results.map(stripInternal)

phase('Synthesize')
const report = await agent(
  `You are consolidating a Rust audit. Below are JSON results from independent review agents. Dimensions come in families: \`review:<crate>\` (one per crate reviewed), \`contract:<from>→<to>\` (one per inter-crate dependency edge), \`crate-decomposition\` (extract/merge recommendations), \`architecture\`, \`security\`, \`miri\`, and the tool dimensions \`semver\`/\`build-matrix\`/\`deps\`/\`unused-crates\` (verified orphan workspace members + unused dependencies)/\`tests-cov\`. Produce ONE markdown report — do not invent findings, only merge what is given:

1. An **overall verdict** line — the worst case across all dimensions. If any dimension did not run, or could not run, mark the audit INCOMPLETE.
2. A **dimension → verdict** table with one row per dimension present (list each \`review:<crate>\` and \`contract:<from>→<to>\` separately). Add a row for every dimension under NOT RUN below with verdict \`NOT RUN\` — its agent failed, so do not treat its absence as a pass. Any dimension whose verdict is \`INCOMPLETE (not run)\` — listed under COULD NOT RUN below — must be rendered as \`COULD NOT RUN\` with a note naming the missing tool, NEVER as Approve or as a blank/green cell: a reader must be able to tell "ran, found nothing" from "never ran". Directly beneath the table, state in one line how many dimensions actually ran out of the total.
3. **Findings by severity** (Critical first), each tagged with its dimension and location, plus a one-line fix direction.
4. A short **"Fix first"** list — the few highest-leverage items across all dimensions.
5. A **"Crate boundaries"** note: summarise the \`crate-decomposition\` extract/merge recommendations (driver + boundary), if any.
6. If a \`review:*\` dimension's summary names a **gate provenance** (CI vs local), surface it in one line under the verdict.

NOT RUN (no result — agent failed or was skipped): ${notRun.length ? notRun.join(', ') : 'none'}
COULD NOT RUN (agent reported back, but its tooling was absent so nothing was checked — treat as uncovered, never as a pass): ${couldNotRun.length ? couldNotRun.join(', ') : 'none'}

RESULTS:
${JSON.stringify(stripped, null, 2)}`,
  // Synthesis is merge/dedup/rank of given verdicts — moderate reasoning, not a deep judgement call.
  { label: 'synthesis', effort: 'medium' },
)

const uc = results.find(r => r.dimension === 'unused-crates')
const auditRecord = {
  schemaVersion: 1,
  runtime: 'claude-code',
  craftVersion: CRAFT_VERSION,
  kind: 'workflow',
  name: 'rust-audit',
  // worstVerdict already returns an INCOMPLETE verdict when there is nothing to aggregate;
  // don't stack a second marker onto it.
  verdict: auditVerdict(worstVerdict(results.map(r => r.verdict)), incompleteDimensions),
  findings: summarizeFindings(results.flatMap(r => (Array.isArray(r.findings) ? r.findings : []))),
  nested: false,
  via: null,
  scout: { baseRef, crateCount: crates.length, changedCrateCount: changedCrates.length, edgeCount: edges.length, hasUnsafe },
  dimensions: stripped.map(r => {
    const s = summarizeFindings(r.findings)
    return { dimension: r.dimension, verdict: r.verdict, findingCount: s.total, bySeverity: s.bySeverity }
  }),
  // The rate is over what was JUDGED, not over the candidates: charging the deaths to the detector
  // is the same conflation the dimension's verdict was fixed for, and this record — not the console
  // report — is what analyze-runs averages into the "noisy lens" call. `refuted` and `died` ride
  // along so a reader can see the two apart; `refuteRate` keeps its name and its 0..1 range, so an
  // older reader keeps working (analyze-runs skips a non-number, which is what an unjudged run now
  // stores instead of a fabricated 0).
  verification: uc && uc._verification
    ? {
      candidates: uc._verification.candidates,
      confirmed: uc._verification.confirmed,
      refuted: uc._verification.refuted ?? null,
      died: uc._verification.died ?? null,
      judged: uc._verification.judged ?? null,
      refuteRate: uc._verification.refuteRate ?? null,
    }
    : null,
  notRun,
  couldNotRun,
  outputTokens: budget.spent(),
}
await logRun(auditRecord)

// The marker LEADS the report: a reader who is about to go look this audit up in the store has to
// learn here that it may not be there.
// `report` comes from an unguarded agent call, and every other agent result in this file is checked
// for death. Interpolating it turns a dead synthesizer into the literal four-character string "null",
// which reads as a successful audit with an empty body — and that is exactly the run where the
// telemetry marker is also empty, so nothing at all says the synthesis died.
if (!report) return `${telemetryLostSection(telemetryLost)}⚠️ INCOMPLETE — the Synthesize agent returned no result, so this audit has NO report. Nothing here is an approval; re-run it.`
return `${telemetryLostSection(telemetryLost)}${report}`
