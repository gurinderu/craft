export const meta = {
  name: 'rust-audit',
  description: 'Full Rust crate audit — per-crate review, inter-crate contracts, architecture, crate decomposition, security, Miri, semver, build-matrix, deps, unused-crate detection (verified), and test/doc health in parallel, synthesized into one report',
  whenToUse: 'Before a release or a big merge, when you want the comprehensive full review — every craft dimension run at once and consolidated into a single verdict. Pass {base} to fix the diff base; {priorDecisions: [<recalled decision records>]} — an object argument only; a string is refused by the nested reviews — is handed to the nested reviews; {mutants:true} to include the slow mutation pass. It audits ONLY the checkout the session runs in: there is no `repo` argument, and passing one is refused with nothing run (use `craft:review` with repo=, or start a session inside that repository).',
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

/** A text argument: its string form when given (truthy), else ''. @param {string} key @returns {string} */
function textArg(key) {
  return A[key] ? String(A[key]) : ''
}

const baseArg = textArg('base')
const runMutants = !!A['mutants']
// Where craft itself lives, so the logger can find lib/craft-log-run.mjs. This engine has NO
// `repo` argument — see the refusal below; it audits the checkout the session runs in, always. As an installed plugin CLAUDE_PLUGIN_ROOT is
// set for us; launched by scriptPath from a checkout it is NOT, and the fallback would resolve
// against the audited repo — where the script is not. Pass craftRoot then.
const craftRootArg = textArg('craftRoot')
// What every nested review inherits from this run: craftRoot (the logger's home) and the project's
// recalled prior decisions, handed through as given — the review engine reads and checks them.
function nestedReviewArgs() {
  return {
    ...(craftRootArg ? { craftRoot: craftRootArg } : {}),
    ...(A['priorDecisions'] != null ? { priorDecisions: A['priorDecisions'] } : {}),
  }
}

const CRATE_ITEM = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'path'],
  properties: {
    name: { type: 'string', description: 'crate (package) name' },
    path: { type: 'string', description: "crate directory (its manifest dir), RELATIVE to the repo root — never the absolute `manifest_path` cargo prints, and never a leading `/`" },
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
  required: ['hasDiff', 'hasUnsafe', 'baseRef', 'repoRoot', 'crates', 'changedCrates', 'edges', 'notes'],
  properties: {
    hasDiff: { type: 'boolean', description: 'true if any .rs files differ vs the base ref (committed or uncommitted)' },
    hasUnsafe: { type: 'boolean', description: 'true if the workspace contains any `unsafe` block or impl' },
    baseRef: { type: 'string', description: 'the git ref the diff was computed against, or empty if none resolved' },
    repoRoot: { type: 'string', description: 'absolute path of the repository root (`git rev-parse --show-toplevel`), empty if it cannot be resolved — used ONLY to relativize a crate path that came back absolute' },
    crates: { type: 'array', items: CRATE_ITEM, description: 'workspace members; empty if cargo metadata is unavailable' },
    changedCrates: { type: 'array', items: CRATE_ITEM, description: 'subset of crates with a changed .rs file vs the base; empty if no base / no changes' },
    edges: { type: 'array', items: EDGE_ITEM, description: 'intra-workspace dependency edges; empty if cargo metadata is unavailable' },
    notes: { type: 'string', description: 'one line on what was detected' },
  },
}

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['dimension', 'verdict', 'summary', 'findings', 'evidence'],
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
    // Positive proof of work (invariant #53): the concrete commands run, tools used, and files read
    // this pass, on one line beginning `Evidence:` — never invented. A claimed-green verdict with an
    // empty evidence field is demoted to INCOMPLETE by demoteUnsupportedGreen (below), so an honest
    // zero-finding pass can only stay green by saying what it did.
    evidence: { type: 'string', description: 'Evidence: <the concrete commands run / tools used / files read this pass — never invented>. A passing verdict with an empty evidence field is treated as INCOMPLETE, not trusted.' },
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

// The shapes the three schemas above make the sandbox hand back. agent() resolves to `null` when the
// subagent is skipped or dies, so every read site takes `<Shape> | null`, never the bare shape.
/** @typedef {{ name: string, path: string }} CrateItem */
/** @typedef {{ from: string, to: string }} EdgeItem */
/**
 * @typedef {{ hasDiff: boolean, hasUnsafe: boolean, baseRef: string, repoRoot: string, crates: CrateItem[],
 *   changedCrates: CrateItem[], edges: EdgeItem[], notes: string }} ScoutResult
 */
/** @typedef {{ severity: string, title: string, location: string, detail: string }} Finding */
/** @typedef {{ dimension: string, verdict: string, summary: string, findings: Finding[], evidence: string }} FindingsResult */
/** @typedef {{ confirmedUnused: boolean, evidence: string, removal: string }} UnusedVerdict */
// One dimension's result as the aggregate reads it: an agent's FindingsResult, a nested review mapped
// by reviewResult (no evidence), or the unused-crates tally (which carries `_verification`).
/**
 * @typedef {{ candidates: number, confirmed: number, refuted: number, died: number, judged: number,
 *   refuteRate: number | null }} VerificationStats
 * @typedef {{ dimension: string, verdict: string, summary: string, findings: Finding[], evidence?: string,
 *   _verification?: VerificationStats, _priorDecisions?: string }} DimResult
 */

// The craft release that produced a run. Recorded on the run record and index line so an
// aggregate can be filtered to ONE engine version: without it, runs from every rubric the store
// has ever seen blend together. MUST match `.claude-plugin/plugin.json` — `lib/check-workflows.mjs`
// fails the build if it drifts. Kept OUTSIDE the craft-inline fence below, whose contents are
// byte-compared against lib/run-record.mjs.
const CRAFT_VERSION = '0.23.1' // x-release-please-version

// ---- run-record helpers (VERBATIM mirror of lib/run-record.mjs — the sandbox can't import; keep in sync) ----
// >>> craft-inline lib/run-record.mjs SEVERITIES countBySeverity summarizeFindings worstVerdict repoRefusal
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
 * @param {unknown} verdicts
 * @returns {string}
 */
function worstVerdict(verdicts) {
  const vs = (Array.isArray(verdicts) ? verdicts : []).map(v => String(v || ''))
  if (!vs.length) return 'INCOMPLETE (no verdicts)'
  if (vs.some(v => /Block|At-risk|UB-found/i.test(v))) return 'Block'
  if (vs.some(v => /Warning|Concerns/i.test(v))) return 'Warning'
  if (vs.some(v => /INCOMPLETE/i.test(v) || !GREEN_VERDICT.test(v))) return 'Warning'
  return 'Approve'
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

// The unused-crates find→verify pipeline's bookkeeping. Extracted to lib/ because its interesting
// cases are the DEATH paths — a verifier that resolves null, one that throws, most of a fan-out
// dying — and nothing in this sandbox can exercise them; lib/audit-verification.test.mjs does, and
// the craft-inline gate pastes the tested source back in here.
// >>> craft-inline lib/audit-verification.mjs wrapVerdict VERIFY_MIN_JUDGED tallyVerification verificationIncomplete unusedCratesResult unusedEvidence
/**
 * @template C, V
 * @param {C} c candidate (model output)
 * @param {V} v verifier verdict (model output); null or undefined when the verifier died
 * @returns {{ c: C, v: NonNullable<V> } | null}
 */
function wrapVerdict(c, v) {
  return v == null ? null : { c, v }
}

const VERIFY_MIN_JUDGED = 0.5

/**
 * @typedef {{ candidates: number, judged: number, confirmed: number, refuted: number, died: number }} VerifyTally
 * @typedef {{ title: string, location?: string, detail?: string }} Candidate  a detector's finding, as the engine's schema shapes it
 * @typedef {{ confirmedUnused?: unknown, evidence?: unknown, removal?: unknown }} UnusedVerdictShape  a verifier's answer (model output), fields unchecked
 */
/**
 * @template C
 * @template {UnusedVerdictShape} V
 * @param {C[]} candidates
 * @param {Array<{ c: C, v: V } | null>} verdicts
 */
function tallyVerification(candidates, verdicts) {
  const list = Array.isArray(candidates) ? candidates : []
  /** @type {Array<{ c: C, v: V }>} */
  const alive = []
  for (const x of (Array.isArray(verdicts) ? verdicts : [])) if (x) alive.push(x)
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
    refuteRate: judged ? Math.round(((judged - confirmedItems.length) / judged) * 100) / 100 : null,
  }
}

/** @param {{ candidates: number, judged: number }} t */
function verificationIncomplete(t) {
  return t.candidates > 0 && t.judged < Math.ceil(t.candidates * VERIFY_MIN_JUDGED)
}

/**
 * @template {Candidate} C
 * @template {UnusedVerdictShape} V
 * @param {C[]} candidates
 * @param {Array<{ c: C, v: V } | null>} verdicts
 */
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
      summary: t.judged
        ? `${t.candidates} candidate(s) flagged; ${t.judged} judged (${t.confirmed} verified unused, ${t.refuted} refuted), ${t.died} verifier(s) died. ${t.candidates - t.judged} candidate(s) are UNVERIFIED — neither confirmed nor cleared.`
        : `${t.candidates} candidate(s) flagged, but every verifier failed to return — none was confirmed OR refuted. The unused-crate surface is UNVERIFIED, not clean.`,
      findings: confirmed.concat(unjudged),
      evidence: unusedEvidence(t),
      _verification,
    }
  }
  return {
    dimension: 'unused-crates',
    verdict: confirmed.length ? 'Warning' : 'Approve',
    summary: `${t.candidates} candidate(s) flagged; ${t.confirmed} verified unused after trying to refute each; ${t.refuted} refuted (kept).${diedNote}`,
    findings: confirmed.length ? confirmed : [{ severity: 'Info', title: 'No verified unused crates', location: '', detail: `${t.candidates} candidate(s) flagged, ${t.refuted} refuted by verification.${diedNote}` }],
    evidence: unusedEvidence(t),
    _verification,
  }
}

/** @param {VerifyTally} t */
function unusedEvidence(t) {
  return `Evidence: ran the orphan/unused-dep detectors and verified each candidate — ${t.candidates} flagged, ${t.judged} judged (${t.confirmed} confirmed unused, ${t.refuted} refuted), ${t.died} verifier(s) died.`
}
// <<< craft-inline

// The positive work-evidence gate (invariant #53): a self-reported GREEN dimension whose evidence
// field carries no `Evidence:` line is demoted to INCOMPLETE by construction, so an honest
// zero-finding pass can only stay green by saying what it did. Extracted to lib/ and tested there
// (the sandbox can't import); the craft-inline gate pastes the tested source back in here, and
// lib/audit-evidence.test.mjs pins EVIDENCE_MARKER to the parity gate's EVIDENCE.field[0].
// >>> craft-inline lib/audit-evidence.mjs EVIDENCE_MARKER EVIDENCE_LINE GREEN_VERDICT hasEvidence demoteUnsupportedGreen
/** @internal */
const EVIDENCE_MARKER = 'Evidence:'

const EVIDENCE_LINE = /^evidence\s*:/i

const GREEN_VERDICT = /^(approve[ds]?|healthy|clean|pass(ed|ing)?|ok(ay)?|fine|good|green|no ub( (detected|found))?|no (issues|findings|problems|defects)( (detected|found))?|none( found)?|nothing (found|to report)|all (clear|good))[\s.!—–-]*$/i

/** @param {unknown} text  free-form agent text; null/undefined read as empty
 * @returns {boolean} */
function hasEvidence(text) {
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '')
    const i = line.search(/[^ \t>*_`#-]/)                         // first non-decoration column (VERDICT_LINE's class)
    if (i < 0) continue                                           // decoration/whitespace only — no marker
    const m = EVIDENCE_LINE.exec(line.slice(i))                   // marker at that column, case- and stray-space tolerant
    if (!m) continue                                              // line does not begin with the marker
    if (/[^ \t>*_`#-]/.test(line.slice(i + m[0].length))) return true  // real content follows it
  }
  return false
}

/** @template {{ verdict?: unknown, evidence?: unknown, summary?: unknown }} R
 * @param {R | null | undefined} r  a dimension result as returned by an agent
 * @returns {R | null | undefined} */
function demoteUnsupportedGreen(r) {
  if (!r || !GREEN_VERDICT.test(String(r.verdict ?? ''))) return r
  if (hasEvidence(r.evidence || r.summary)) return r
  return { ...r, verdict: `INCOMPLETE (no evidence — claimed ${r.verdict})` }
}
// <<< craft-inline

// Free text in, vocabulary out: map an agent's verdict onto the aggregate's language. Greenness is
// GREEN_VERDICT (inlined above from lib/audit-evidence.mjs — the one green authority the evidence gate
// shares); a match becomes Approve. INCOMPLETE passes through untouched; anything genuinely
// unrecognisable is returned UNCHANGED, so it still lands in the non-permissive branch of
// worstVerdict — this widens the green vocabulary, it never weakens the default.
/** @param {unknown} v model output */
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
/**
 * @param {string} worst
 * @param {unknown[]} notRun
 */
function auditVerdict(worst, notRun) {
  if (!notRun.length || /INCOMPLETE/i.test(worst)) return worst
  return `${worst} (INCOMPLETE)`
}

// Drop internal (`_`-prefixed) keys so they never leak into the synthesis prompt.
/**
 * @param {Record<string, unknown>} obj
 * @returns {Record<string, unknown>}
 */
function stripInternal(obj) {
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const k of Object.keys(obj)) if (!k.startsWith('_')) out[k] = obj[k]
  return out
}
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
// The banner that leads the report when a write did not land — the same one review.js uses.
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

// A lost record NEVER fails the audit: killing it over a bookkeeping write would teach everyone to
// ignore the very marker this exists to raise. It is reported instead, at the head of the report a
// human actually reads — an empty store is otherwise indistinguishable from "never run".
/** @type {string[]} */
const telemetryLost = []
// The shared run-record writer (lib/run-logging.mjs), bound to this engine's phase and loss note.
const logRun = makeRunLogger({
  call: quietly(agent), phase: 'Synthesize', target: () => ({ craftRoot: craftRootArg }),
  noteLoss: telemetryLossNoter(telemetryLost, log),
})

// Plugin agent types (craft:*) are frequently absent from the workflow sandbox's registry. Dispatch
// to the requested agentType, but on an "agent type '<x>' not found" throw — or a null on runtimes
// that signal a missing type that way — fall back to the generic subagent (the briefs are
// self-contained) and REMEMBER the miss so later dimensions skip straight to generic instead of
// re-failing. Without this, the contract/architecture/security/miri dimensions silently become
// NOT RUN whenever the craft agents aren't registered.
// What fell back is also SAID — in the report and on the record — with the same match and wording as the
// review engine (lib/agent-fallback.mjs, realm @nick/craft #116): a weaker audit must not read as a
// normal one.
// >>> craft-inline lib/agent-fallback.mjs isAgentTypeMissing agentUnavailableSection agentUnavailableRecord readAgentUnavailableSection readAgentUnavailableLine
/** @param {unknown} msg @param {string} [agent] */
function isAgentTypeMissing(msg, agent) {
  const m = String(msg ?? '')
  return /not found/i.test(m) && (/agent type/i.test(m) || (!!agent && m.includes(agent)))
}

/**
 * @param {{ agent: string, what: string, error?: string }[]} missing
 * @param {{ agent: string, count: number, what: string, error?: string }[]} emptied
 * @returns {string}
 */
function agentUnavailableSection(missing, emptied) {
  const hard = Array.isArray(missing) ? missing : []
  const soft = (Array.isArray(emptied) ? emptied : []).filter(x => x && x.count > 0)
  if (!hard.length && !soft.length) return ''
  /** @param {unknown} e */
  const quote = e => String(e).replace(/\s+/g, ' ').trim().slice(0, 160)
  const lines = [
    ...hard.map(x => `- \`${x.agent}\` is not registered in this session, so ${x.what} went to the generic subagent, without that agent's rubric — this run is weaker than a normal one, not broken.${x.error ? ` (${quote(x.error)})` : ''}`),
    ...soft.map(x => x.error
      ? `- \`${x.agent}\` failed with "${quote(x.error)}" on ${x.count} ${x.what}, which were re-run on the generic subagent, without its rubric (an unregistered agent in wording this engine does not recognise, or a missing model or tool).`
      : `- \`${x.agent}\` returned nothing for ${x.count} ${x.what}, which were re-run on the generic subagent, without its rubric (an unregistered agent on some runtimes, or a transient failure).`),
  ]
  const fix = hard.length ? 'Enable the plugin in this project (`/plugin install craft@craft`, project or local scope) and re-run to use it.\n' : ''
  return `## ⚠️ Reviewer agent unavailable\n${lines.join('\n')}\n${fix}\n`
}

/**
 * @param {Iterable<string>} missing
 * @param {{ agent: string, count: number }[]} fallbacks
 * @returns {{ agentUnavailable: string[], agentFallbacks: Record<string, number> }}
 */
function agentUnavailableRecord(missing, fallbacks) {
  /** @type {Record<string, number>} */
  const agentFallbacks = {}
  for (const x of fallbacks) if (x.count > 0) agentFallbacks[x.agent] = (agentFallbacks[x.agent] || 0) + x.count
  return { agentUnavailable: [...new Set(missing)].sort(), agentFallbacks }
}

/**
 * @param {unknown} report
 * @returns {{ missing: { agent: string, error: string }[], emptied: { agent: string, count: number, error?: string }[] }}
 */
function readAgentUnavailableSection(report) {
  /** @type {{ agent: string, error: string }[]} */
  const missing = []
  /** @type {{ agent: string, count: number, error?: string }[]} */
  const emptied = []
  const text = String(report ?? '')
  const head = text.indexOf('## ⚠️ Reviewer agent unavailable\n')
  if (head < 0) return { missing, emptied }
  for (const line of text.slice(head).split('\n').slice(1)) {
    if (!line.startsWith('- ')) break
    const got = readAgentUnavailableLine(line)
    if ('count' in got) emptied.push(got)
    else missing.push(got)
  }
  return { missing, emptied }
}

/** @param {string} line @returns {{ agent: string, error: string } | { agent: string, count: number, error?: string }} */
function readAgentUnavailableLine(line) {
  const hard = /^- `([^`]+)` is not registered in this session, .*? not broken\.(?: \((.*)\))?$/.exec(line)
  if (hard) return { agent: String(hard[1]), error: hard[2] || '' }
  const threw = /^- `([^`]+)` failed with "(.*)" on (\d+) /.exec(line)
  if (threw) return { agent: String(threw[1]), count: Number(threw[3]), error: threw[2] || '' }
  const empty = /^- `([^`]+)` returned nothing for (\d+) /.exec(line)
  if (empty) return { agent: String(empty[1]), count: Number(empty[2]) }
  return { agent: /`([^`]+)`/.exec(line)?.[1] || 'a craft agent', error: line.slice(2, 162) }
}
// <<< craft-inline
/** @type {Map<string, string>} */
const agentTypeMissing = new Map()      // agent type -> the error the engine saw
/** @type {Record<string, number>} */
const agentTypeEmptied = {}             // agent type -> dispatches that came back empty and the generic subagent answered
/** @type {Map<string, { count: number, error: string }>} */
const agentTypeNotFound = new Map()     // agent type -> dispatches that threw an unrecognised "not found" and the generic subagent answered
/**
 * @param {string} prompt
 * @param {AgentOptions} [opts]  the sandbox's closed option set — a misspelt key fails the type check
 * @returns {Promise<unknown>}
 */
async function safeAgent(prompt, opts = {}) {
  const at = opts['agentType']
  const generic = { ...opts }
  delete generic['agentType']
  if (!at || agentTypeMissing.has(at)) return agent(prompt, generic)
  try {
    const res = await agent(prompt, opts)
    if (res != null) return res
    return await genericAfterNull(prompt, generic, at)
  } catch (e) {
    return await genericAfterThrow(e, prompt, generic, at)
  }
}
/**
 * null: try generic once; don't memoize (may be transient). Counted only when the generic run
 * ANSWERED: the section says what entered the audit without the rubric, and a dispatch that died on
 * both paths is a dead dimension (NOT RUN), the same outcome as one that threw.
 * @param {string} prompt @param {AgentOptions} generic @param {string} at @returns {Promise<unknown>}
 */
async function genericAfterNull(prompt, generic, at) {
  const fallback = await agent(prompt, generic)
  // Falsy, not just null: dimResult reads any falsy result as a dead dimension.
  if (fallback) agentTypeEmptied[at] = (agentTypeEmptied[at] || 0) + 1
  return fallback
}
/**
 * The agent type's dispatch threw: fall back to the generic subagent when the error says the type is
 * missing (memoized) or says "not found" in words that may mean it (not memoized); rethrow otherwise.
 * @param {unknown} e @param {string} prompt @param {AgentOptions} generic @param {string} at @returns {Promise<unknown>}
 */
async function genericAfterThrow(e, prompt, generic, at) {
  const msg = String((e && /** @type {{ message?: unknown }} */ (e).message) || e)
  // A "not found" that does not name the agent type may still be the harness's way of saying it —
  // the sandbox's wording is not yet observed (#152) — so the dimension keeps its coverage on the generic
  // subagent, said softly (no install line), and is not memoized: a real unregistered type in unknown
  // wording costs one failed agent dispatch per dimension — the price of not guessing at the text.
  if (!isAgentTypeMissing(msg, at)) {
    if (!/not found/i.test(msg)) throw e
    const fallback = await agent(prompt, generic)
    // Dead on both paths: the agent's error is the only one there is, so it is rethrown for the
    // dimension's NOT RUN line rather than lost to an anonymous "no result".
    if (!fallback) throw e
    agentTypeNotFound.set(at, { count: (agentTypeNotFound.get(at)?.count || 0) + 1, error: msg })
    return fallback
  }
  agentTypeMissing.set(at, msg)
  log(`⚠️ agent type '${at}' not registered here — falling back to the generic subagent for the rest of this audit`)
  const fallback = await agent(prompt, generic)
  // Dead on the generic path too: the dimension is NOT RUN, and its line names the agent's error.
  if (!fallback) throw e
  return fallback
}
// What each nested review said in its own section (realm @nick/craft #153): the audit receives only the
// nested report, so it reads the section back (readAgentUnavailableSection) and names the dimension.
/** @type {{ dimension: string, missing: { agent: string, error: string }[], emptied: { agent: string, count: number, error?: string }[] }[]} */
const nestedAgentNotes = []
/** @param {string} dimension @param {unknown} report */
function noteNestedAgents(dimension, report) {
  const got = readAgentUnavailableSection(report)
  if (got.missing.length || got.emptied.length) nestedAgentNotes.push({ dimension, ...got })
}
const agentSection = () => agentUnavailableSection(
  [
    ...[...agentTypeMissing].map(([agent, error]) => ({ agent, what: 'the audit dimensions that use it', error })),
    ...nestedAgentNotes.flatMap(n => n.missing.map(x => ({ agent: x.agent, what: `the lenses of the nested review ${n.dimension}`, error: x.error }))),
  ],
  [
    ...Object.entries(agentTypeEmptied).map(([agent, count]) => ({ agent, count, what: 'dimension dispatch(es)' })),
    ...[...agentTypeNotFound].map(([agent, x]) => ({ agent, count: x.count, what: 'dimension dispatch(es)', error: x.error })),
  ].filter(x => !agentTypeMissing.has(x.agent)).concat(
    nestedAgentNotes.flatMap(n => n.emptied.map(x => ({ ...x, what: `lens dispatch(es) of the nested review ${n.dimension}` })))),
)
// The record, in the shape both engines write: this audit's OWN misses and fallbacks only. Each nested
// review files its own record (`nested`, `via: 'rust-audit'`) carrying its fact, and analyze-runs counts
// every record alike, so folding the nested fact in here counted one unavailable agent twice; the
// nested fact stays in this audit's report section above.
const agentRecord = () => agentUnavailableRecord(
  agentTypeMissing.keys(),
  [
    ...Object.entries(agentTypeEmptied).map(([agent, count]) => ({ agent, count })),
    ...[...agentTypeNotFound].map(([agent, x]) => ({ agent, count: x.count })),
  ],
)

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
  const refused = repoRefusal({ engine: 'rust-audit', repo: String(A['repo']), craftVersion: CRAFT_VERSION, outputTokens: budget.spent() })
  await logRun(refused.record)
  return refused.report
}


/** The scout's step 1: the given base, or the fallbacks to try. @returns {string} */
function baseInstruction() {
  return baseArg
    ? `Use \`${baseArg}\` as the base ref.`
    : 'Try in order until one resolves: `git merge-base HEAD origin/main`, `git merge-base HEAD main`, `HEAD~1`.'
}

phase('Scout')
const scout = /** @type {ScoutResult | null} */ (await agent(
  `You are scouting a Rust workspace to plan an audit. Use shell commands only — do NOT review anything yet.

1. Determine the diff base. ${baseInstruction()}
2. hasDiff = true if \`git diff --name-only <base>...HEAD\` lists any \`.rs\` file, OR \`git status --porcelain\` shows uncommitted \`.rs\` changes.
3. hasUnsafe = true if \`grep -rnE "\\bunsafe\\b" --include=*.rs .\` finds any match (a rough check is fine; ignore obvious comment-only hits if cheap to do).
4. baseRef = the ref you actually used (empty string if none resolved).
5. crates = workspace members from \`cargo metadata --no-deps --format-version 1\` — each as {name, path} where path is the crate's manifest directory RELATIVE to the repo root. \`cargo metadata\` prints \`manifest_path\` as an ABSOLUTE file path: strip the repo root and the trailing \`/Cargo.toml\` yourself (the workspace root crate is \`.\`). An absolute path here cannot be used as a git pathspec and the per-crate review it feeds will refuse to run. Empty array if \`cargo metadata\` is unavailable.
5b. repoRoot = \`git rev-parse --show-toplevel\` (empty string if it fails). It is the fallback that lets the script repair an absolute crate path; it is not a substitute for step 5.
6. changedCrates = the subset of \`crates\` whose directory contains a \`.rs\` file listed by \`git diff --name-only <base>...HEAD\` (or \`git status --porcelain\` for uncommitted work). Empty if no base or no changed \`.rs\`.
7. edges = intra-workspace dependency edges from \`cargo metadata --format-version 1\`: {from, to} where BOTH \`from\` and \`to\` are workspace members and \`from\` depends on \`to\`. Empty array if \`cargo metadata\` is unavailable.`,
  // Scout is pure mechanics (git refs + grep) — run it cheap: Haiku at low effort.
  { label: 'scout', schema: SCOUT_SCHEMA, model: 'haiku', effort: 'low' },
))
/**
 * What the audit reads from the scout. scout is null if the agent was skipped or died — fall back to
 * safe defaults rather than crash.
 * @param {ScoutResult | null} s
 * @returns {{ baseRef: string, hasUnsafe: boolean, repoRoot: string, crates: CrateItem[], changedCrates: CrateItem[], edges: EdgeItem[], notes: string }}
 */
function scoutFacts(s) {
  const noNotes = 'scout produced no result — assuming unsafe present, no base ref'
  // fail-safe: run Miri when detection didn't resolve
  if (!s) return { baseRef: '', hasUnsafe: true, repoRoot: '', crates: [], changedCrates: [], edges: [], notes: noNotes }
  return {
    baseRef: s.baseRef ?? '',
    hasUnsafe: s.hasUnsafe ?? true,
    repoRoot: typeof s.repoRoot === 'string' ? s.repoRoot.trim() : '',
    crates: Array.isArray(s.crates) ? s.crates : [],
    changedCrates: Array.isArray(s.changedCrates) ? s.changedCrates : [],
    edges: Array.isArray(s.edges) ? s.edges : [],
    notes: s.notes ?? noNotes,
  }
}
const { baseRef, hasUnsafe, repoRoot, crates, changedCrates, edges, notes: scoutNotes } = scoutFacts(scout)
// A crate directory must reach the nested `review` as a REPO-RELATIVE pathspec. Asking the scout for
// one is not enough: `cargo metadata` prints `manifest_path` absolute, so a scout that copies it out
// hands back absolute crate directories — and `review` now REFUSES an absolute `path` (it cannot
// tell a repository from a scope) instead of running a whole-repo review under a crate's label. The
// refusal is right and it is also the whole per-crate measurement, so the repair belongs here, at the
// boundary the bad value crosses. Segments, not a string prefix: `/r/` + `/r/./crates/core` is the
// same request as `crates/core`. No disk and no Node API here, so a symlinked or differently-cased
// spelling stays unrepairable — such a crate is reported NOT RUN rather than reviewed unscoped.
const ABSOLUTE_PATH = /^(\/|~(\/|$)|[A-Za-z]:[\\/])/
// >>> craft-inline lib/path-segments.mjs pathSegments
/** @param {unknown} p */
function pathSegments(p) {
  const segs = []
  for (const s of String(p).split(/[\\/]+/)) {
    if (!s || s === '.') continue
    if (s === '..' && segs.length && segs[segs.length - 1] !== '..') { segs.pop(); continue }
    segs.push(s)
  }
  return segs
}
// <<< craft-inline
// The repo-relative crate directory, or null when it cannot be derived.
/** @param {unknown} p */
function crateScope(p) {
  const raw = String(p ?? '').trim()
  if (!raw) return null
  if (!ABSOLUTE_PATH.test(raw)) {
    // A relative path must stay INSIDE the repository, and `pathSegments` keeps a leading `..` as a
    // literal segment when there is nothing left to pop — so `../../elsewhere` normalized to itself
    // and was handed to the nested `review` as a pathspec climbing out of the repo under audit. The
    // absolute branch below already refuses exactly this (a path that does not resolve inside the
    // root); the relative branch let it through the door next to it. Same answer: null, which the
    // caller reports as NOT RUN rather than reviewing something else under this crate's label.
    const segs = pathSegments(raw)
    if (segs[0] === '..') return null
    return segs.join('/') || '.'
  }
  return absoluteScope(raw)
}
// An absolute crate path made relative to the repo root, or null when it does not resolve inside it.
/** @param {string} raw @returns {string | null} */
function absoluteScope(raw) {
  const r = pathSegments(repoRoot)
  const abs = pathSegments(raw)
  if (!repoRoot || !r.length || abs.length < r.length) return null
  for (let i = 0; i < r.length; i++) if (abs[i] !== r[i]) return null
  return abs.slice(r.length).join('/') || '.'
}
log(scoutNotes)

phase('Audit')

// Map a rust-review workflow report string into a FINDINGS_SCHEMA-shaped dimension result.
// A review report has a stable shape: a `## Verdict` heading whose first non-empty following line
// IS the verdict. Classify on that line alone — the body legitimately contains ⚠️ and the word
// INCOMPLETE (the "Not reviewed" list, "Coverage gaps"), so a substring match over the whole report
// scored a plain Approve as a Warning and any mention of the word as uncovered. A report with no
// `## Verdict` heading is one we cannot read, and the non-permissive default applies.
/** @param {unknown} report */
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

/** @param {string | null} line @param {boolean} incomplete @returns {string} */
function reviewVerdict(line, incomplete) {
  if (line == null) return 'Warning'
  if (/⛔|Block/.test(line)) return 'Block'
  if (/⚠️|Warning/.test(line)) return 'Warning'
  if (incomplete) return 'Warning'
  return /✅|Approve/.test(line) ? 'Approve' : 'Warning'
}

// The summary reads the SAME `incomplete` flag as the verdict, so the two can never diverge on
// it: a `⛔ Block (INCOMPLETE)` is a Block AND carries the partial-coverage clause, never a bare
// "uncovered" that would report one dimension as both a Block and a mere absence of coverage.
/** @param {string | null} line @param {string} verdict @param {boolean} incomplete @returns {string} */
function reviewSummary(line, verdict, incomplete) {
  if (line == null) return 'Deep review verdict could not be read — this dimension is unverified, not clean.'
  if (verdict === 'Block') return `Deep review returned a BLOCK — blocking findings below${incomplete ? '; coverage was also partial, so there may be more' : ''}.`
  return incomplete
    ? 'Deep review did NOT run to completion — this dimension is uncovered, not clean.'
    : 'Elastic deep review — see findings below.'
}

/**
 * @param {string} dimension
 * @param {unknown} report
 */
function reviewResult(dimension, report) {
  const line = verdictLine(report)
  // A coverage-hole clause voids an otherwise-green verdict whether the engine spelled it INCOMPLETE
  // (a genuine not-run) or PARTIAL COVERAGE (files no language profile covered) — review.js writes both
  // via verdictSuffix (lib/review-coverage.mjs), and the model may drop the ⚠️ glyph when it rewrites
  // the verdict line, so this classifies on the WORDS, not the emoji. It matches both markers, the same
  // widening lib/analyze-runs.mjs's isIncomplete carries, so this reader and the run store never
  // disagree — and it drives BOTH the verdict step below and the summary, which can then never diverge.
  const incomplete = /INCOMPLETE|PARTIAL COVERAGE/i.test(line || '')
  // SEVERITY FIRST, then coverage — the same rule lib/analyze-runs.mjs states and implements for the
  // run store, and the two must not disagree. A `⛔ Block (INCOMPLETE)` is a block: partial coverage
  // cannot un-find a finding that was already made, so it must not be downgraded to Warning. Only an
  // otherwise-green verdict is voided by incompleteness, because an Approve is a claim about what was
  // NOT found and holds only over what was actually looked at. Anything unreadable is Warning.
  const verdict = reviewVerdict(line, incomplete)
  const summary = reviewSummary(line, verdict, incomplete)
  const kept = liftPriorDecisionSections(String(report || 'no report'))
  return {
    dimension,
    verdict,
    summary,
    findings: [{ severity: 'Info', title: 'Deep review report', location: '', detail: kept.rest.slice(0, 4000) }],
    ...(kept.lifted ? { _priorDecisions: kept.lifted } : {}),
  }
}

// The nested reviews' prior-decision sections, lifted before the bound in reviewResult and appended
// whole to the audit — they sit at the report's tail, where the bound cuts.
// >>> craft-inline lib/prior-decision-report.mjs PRIOR_DECISION_HEADINGS liftPriorDecisionSections nestedPriorDecisionsSection
const PRIOR_DECISION_HEADINGS = ['## Rejected before (set aside — not in the verdict)', '## Prior decisions not applied']

/**
 * The report without its prior-decision sections, and those sections, each from its heading to the
 * next `## ` heading or the end.
 * @param {string} report @returns {{ rest: string, lifted: string }}
 */
function liftPriorDecisionSections(report) {
  const lines = report.split('\n')
  /** @type {string[]} */
  const rest = []
  /** @type {string[]} */
  const lifted = []
  let inside = false
  for (const line of lines) {
    if (line.startsWith('## ')) inside = PRIOR_DECISION_HEADINGS.includes(line.trim())
    ;(inside ? lifted : rest).push(line)
  }
  return { rest: rest.join('\n'), lifted: lifted.join('\n').trim() }
}

/**
 * The outer report's section carrying every nested review's lifted text under its dimension; '' when
 * none had any.
 * @param {Array<{ dimension: string, text: string }>} lifted @returns {string}
 */
function nestedPriorDecisionsSection(lifted) {
  const given = lifted.filter(l => l.text)
  if (!given.length) return ''
  return `\n\n## Prior decisions in the nested reviews (verbatim)\n${given.map(l => `### ${l.dimension}\n${l.text}`).join('\n\n')}\n`
}
// <<< craft-inline

// The nested review launches below resolve the child under whichever name this registry carries —
// the fence's own comment states the rule and the fallback's single trigger.
// >>> craft-inline lib/nested-workflow.mjs nestedWorkflow
/**
 * @param {(name: string, args: unknown) => Promise<unknown>} workflow
 * @param {string} name
 * @param {unknown} args
 * @param {(msg: string) => void} [warn]
 * @returns {Promise<unknown>} the nested run's result — `null` when it died
 */
async function nestedWorkflow(workflow, name, args, warn = () => {}) {
  /** @param {unknown} e @returns {unknown} the refusal's message, or the thrown value itself */
  const messageOf = e => (e && /** @type {{ message?: unknown }} */ (e).message) || e
  /** @param {unknown} e */
  const unresolved = e => /no workflow with that name/i.test(String(messageOf(e)))
  try {
    return await workflow(`craft:${name}`, args)
  } catch (e) {
    if (!unresolved(e)) throw e
    warn(`nested workflow 'craft:${name}' did not resolve here — retrying as '${name}'`)
    try {
      return await workflow(name, args)
    } catch (e2) {
      if (unresolved(e2)) {
        throw new Error(`nested workflow '${name}': neither 'craft:${name}' nor '${name}' resolved — the nested run did NOT happen (last refusal: ${String(messageOf(e2))})`)
      }
      throw e2
    }
  }
}
// <<< craft-inline

// Dimensions are assembled dynamically; `dispatched` records one label per thunk and drives the
// NOT-RUN bookkeeping (a thunk that returns null is flagged NOT RUN).

// A dimension fails to produce a result in TWO ways, and BOTH have to reach the run log as something
// a genuine skip is not (#84's invariant) — otherwise a dead dimension and a skipped one land in the
// report's NOT RUN list identically:
//   - it RESOLVES to null. For an AGENT dimension this is the agent()/safeAgent contract (lines
//     260-262 / 697-712): a terminal API error OR a skip resolves null (tool absence does NOT — that
//     returns a real `INCOMPLETE (not run)` result), so the honest reason is the ambiguous
//     "died or skipped". For a NESTED-REVIEW dimension a null is unambiguous: the nested-workflow
//     contract (line 875) makes `null` a nested engine that DIED, so its reason names a death.
//   - it THROWS. agent() throws on budget exhaustion (line 261) and safeAgent RETHROWS any
//     non-"not found" error (line 707); a nested review throws on a name-resolution refusal or a
//     mid-run failure of the child. parallel() (lib/engine-harness.mjs) then swallows the rejected
//     thunk to a bare null BEFORE the `.then` transform runs, so the null would reach the NOT-RUN
//     bookkeeping with no reason logged at all. dispatchDim's `.catch` names this half.
// dispatchDim routes EVERY dimension — agent AND nested-review — through both halves in one place, so
// no sub-death is silent and the invariant is held by the shape of the dispatch, not by a `.catch`
// remembered at each of a dozen sites. Round 3 proved the review dimension's hand-rolled chain, kept
// OUT of this dispatch on the ground that it "was already correct", missed its own resolve-null half:
// a dead nested review (report==null) reached reviewResult, which returns a truthy Warning, so it
// landed in `results` instead of NOT RUN — indistinguishable from a review that ran but whose verdict
// was merely unreadable. Folding it in closes that; the review chain resolves to null on report==null
// BEFORE reviewResult (below), so reviewResult only ever sees a report that actually came back.
//
// The two resolve-null reasons differ in meaning — an agent's ambiguous "died or skipped" vs a nested
// review's definite death — so dimResult takes the reason as an argument rather than asserting one it
// cannot confirm. Likewise the throw line: `opts.threw` lets a review keep its own "review failed:"
// wording (which stays legible as refusal-vs-death). The defaults carry the agent-dimension wording,
// so the agent sites call `dispatchDim(dim, promise)` with no options, the promise cast to its result type.
// `evidenceGate` (default ON) runs a self-reported GREEN result through demoteUnsupportedGreen: a
// claimed pass with no `Evidence:` line becomes INCOMPLETE by construction (invariant #53), and —
// because the demoted string leads with INCOMPLETE — falls into couldNotRun/worstVerdict with no
// change to the rollup. The `review`/`review:<crate>` sites pass it false: their verdict is grounded
// by review.js's confirmed-finding count and their synthetic summary carries no marker, so gating
// them would demote every honest zero-finding review (the one false-positive the design excludes).
/**
 * @param {string} dimension
 * @param {DimResult | null | undefined} r agent result
 * @param {string} deadReason
 * @param {boolean} [evidenceGate]
 */
function dimResult(dimension, r, deadReason, evidenceGate = true) {
  if (!r) { log(`${dimension}: ${deadReason}`); return null }
  const tagged = { ...r, dimension }
  if (!evidenceGate) return tagged
  const demoted = demoteUnsupportedGreen(tagged)
  if (demoted !== tagged) log(`${dimension}: reported ${r.verdict} with no Evidence — demoted to ${demoted?.verdict}`)
  return demoted
}

/**
 * @param {string} dimension
 * @param {Promise<DimResult | null>} promise agent result
 * @param {{ deadReason?: string, threw?: (msg: unknown) => string, evidenceGate?: boolean }} [opts]
 */
function dispatchDim(dimension, promise, opts = {}) {
  const deadReason = opts.deadReason || 'agent returned no result (died or skipped) — dimension NOT RUN'
  const threw = opts.threw || (msg => `${dimension}: agent threw — ${msg} — dimension NOT RUN`)
  return promise
    .then(r => dimResult(dimension, r, deadReason, opts.evidenceGate ?? true))
    .catch((/** @type {unknown} */ e) => { log(threw((e && /** @type {{ message?: unknown }} */ (e).message) || e)); return null })
}

/** @type {Array<() => Promise<DimResult | null | undefined> | null>} */
const tasks = []
/** @type {string[]} */
const dispatched = []

// Review dimension — per-crate fan-out (feature A). changedCrates → diff-scoped; no base → all
// crates; 0 or 1 crate → today's single whole-workspace review.
/** Queues the review dimension: one nested review per crate, or one for the whole workspace. */
function pushReviewDims() {
  const reviewCrates = changedCrates.length ? changedCrates : (baseRef ? [] : crates)
  if (reviewCrates.length > 1) {
    for (const c of reviewCrates) {
      const scope = crateScope(c.path)
      if (scope == null) {
        // Dispatching it unscoped would review the WHOLE workspace under this crate's label — the
        // failure this family exists to end. A null thunk lands in the NOT-RUN bookkeeping, which is
        // what an unmeasured crate actually is.
        log(`⚠️ crate ${c.name}: path=${String(c.path)} could not be made repo-relative (repoRoot=${repoRoot || 'unresolved'}) — its per-crate review is NOT RUN rather than silently widened to the whole workspace`)
        tasks.push(() => null)
        dispatched.push(`review:${c.name}`)
        continue
      }
      tasks.push(() => dispatchDim(`review:${c.name}`,
        nestedWorkflow(workflow, 'review', { base: baseRef, path: scope, languages: ['rust'], _via: 'rust-audit', ...nestedReviewArgs() }, log)
          // report==null is a dead nested engine (nested-workflow contract, line 875): resolve to null
          // HERE so it lands in NOT RUN like any other death, and reviewResult only ever sees a report
          // that came back — an unreadable verdict there is a real run, kept as a Warning in results.
          .then(/** @param {unknown} report */ report => { if (report == null) return null; noteNestedAgents(`review:${c.name}`, report); return reviewResult(`review:${c.name}`, report) }),
        // A swallowed throw is a name that would not resolve OR a run that died; keep the
        // "review:<crate> failed:" wording so the reason (refusal vs death) stays legible and distinct.
        // evidenceGate:false — a review verdict is grounded by review.js's confirmed-finding count, and
        // reviewResult's synthetic summary carries no `Evidence:` marker; gating it would demote every
        // honest zero-finding review.
        { deadReason: 'nested review returned no result (died) — dimension NOT RUN',
          threw: msg => `review:${c.name} failed: ${msg}`, evidenceGate: false }))
      dispatched.push(`review:${c.name}`)
    }
  } else {
    // Without craftRoot the child resolves its logger from CLAUDE_PLUGIN_ROOT alone and, in a checkout
    // launch, cannot log at all — every nested record lost while the parent's lands.
    tasks.push(() => dispatchDim('review',
      nestedWorkflow(workflow, 'review', baseRef ? { base: baseRef, languages: ['rust'], _via: 'rust-audit', ...nestedReviewArgs() }
                                                  : { languages: ['rust'], _via: 'rust-audit', ...nestedReviewArgs() }, log)
        // As at the per-crate site: report==null is a dead nested engine — resolve to null before
        // reviewResult so it lands in NOT RUN, not as a truthy Warning in results.
        .then(/** @param {unknown} report */ report => { if (report == null) return null; noteNestedAgents('review', report); return reviewResult('review', report) }),
      // evidenceGate:false — as at the per-crate site: the review verdict is finding-count-grounded and
      // reviewResult's summary carries no `Evidence:` marker, so the gate must not touch it.
      { deadReason: 'nested review returned no result (died) — dimension NOT RUN',
        threw: msg => `review failed: ${msg}`, evidenceGate: false }))
    dispatched.push('review')
  }
}
pushReviewDims()

// Contracts dimension (feature B) — one focused review per TOUCHED intra-workspace edge. An edge
// is touched when its caller or callee is a changed crate; with no base, every edge is touched.
/** Queues one contract review per touched edge, or says why there are none. */
function pushContractDims() {
  const changedNames = new Set(changedCrates.map(c => c.name))
  const touchedEdges = edges.filter(e => !baseRef || changedNames.has(e.from) || changedNames.has(e.to))
  if (touchedEdges.length) {
    // The agent `label` uses an ASCII `->` (display-safe); the `dimension` and the matching
    // `dispatched` entry use the Unicode `→` (U+2192). Keep those two in sync — the NOT-RUN
    // bookkeeping compares `dispatched` against `dimension`; do NOT "unify" them to the label's `->`.
    for (const e of touchedEdges) {
      tasks.push(() => dispatchDim(`contract:${e.from}→${e.to}`, /** @type {Promise<FindingsResult | null>} */ (safeAgent(
        `Review the call contract on the workspace dependency edge \`${e.from}\` → \`${e.to}\`: does \`${e.from}\` use \`${e.to}\`'s PUBLIC API the way its contract intends? Check signatures and types at the boundary, error and panic contracts, documented invariants and trait laws, and the semver/breaking-change compatibility of \`${e.to}\`'s public surface against \`${e.from}\`'s usage. Load the rust-review skill (the api-design pass), rust-errors (error contracts), and rust-traits (trait laws) for the rubric. Return a verdict and findings.\n\nObservability: the rust-audit workflow records this run — do NOT write your own record.`,
        { label: `contract:${e.from}->${e.to}`, agentType: 'craft:rust-reviewer', phase: 'Audit', schema: FINDINGS_SCHEMA, model: 'opus' },
      ))))
      dispatched.push(`contract:${e.from}→${e.to}`)
    }
  } else {
    log('No intra-workspace dependency edges to review — skipping the contracts dimension.')
  }
}
pushContractDims()

// Crate-decomposition dimension (feature C) — whole-project; runs even on a single crate.
tasks.push(() => dispatchDim('crate-decomposition', /** @type {Promise<FindingsResult | null>} */ (agent(
  `Judge this Rust workspace's crate boundaries and recommend where code should be EXTRACTED into its own crate, or where an over-split crate should be MERGED back. Load the rust-ecosystem skill and its crate-extraction.md rubric, and build on the workspace dependency graph (\`cargo metadata\`). For EACH recommendation give: the DRIVER (reuse / compile parallelism / dependency inversion / trust boundary / independent semver / test isolation / god-crate split — or, for a merge, "single consumer, no boundary reason"), the BOUNDARY (which module or code), and the HOW. Recommend only — do NOT move code. Return a verdict (Healthy / Concerns / At-risk) and findings. Fill the \`evidence\` field with one line beginning \`Evidence:\` naming the exact commands you ran (e.g. \`cargo metadata\`) and manifests you read this pass — a passing verdict with an empty evidence field is treated as INCOMPLETE, not trusted.`,
  { label: 'crate-decomposition', phase: 'Audit', schema: FINDINGS_SCHEMA, effort: 'medium' },
))))
dispatched.push('crate-decomposition')

tasks.push(() => dispatchDim('architecture', /** @type {Promise<FindingsResult | null>} */ (safeAgent(
  `Audit the architecture of this whole Rust project against the rust-architecture-review rubric (load the rust-architecture-review skill). Build the crate/module dependency graph and judge the structure in BOTH directions — too little (layer leaks, god modules) and too much (ghost abstractions, over-layering). Return your health rating and findings. If NO dependency graph could be built at all (cargo metadata/tree failed, cargo-modules absent, and no manifest or source structure was readable), nothing was judged: return verdict "INCOMPLETE (not run)" naming what was missing — not "Healthy". A graph built from the source fallback IS a graph: rate it normally.\n\nObservability: the rust-audit workflow records this run — do NOT write your own record.`,
  { label: 'architecture', agentType: 'craft:rust-architecture-reviewer', phase: 'Audit', schema: FINDINGS_SCHEMA },
))))
dispatched.push('architecture')

tasks.push(() => dispatchDim('security', /** @type {Promise<FindingsResult | null>} */ (safeAgent(
  `Run the Rust security toolchain (cargo-audit, cargo-deny, cargo-geiger, semgrep — whatever is available) against the rust-security rubric (load the rust-security skill). Consolidate into a severity-ranked verdict and findings. If NONE of the tools is installed, so nothing was actually scanned, return verdict "INCOMPLETE (not run)" and name the missing tools — a scan that ran nothing is not an Approve.\n\nObservability: the rust-audit workflow records this run — do NOT write your own record.`,
  { label: 'security', agentType: 'craft:rust-security-scanner', phase: 'Audit', schema: FINDINGS_SCHEMA, model: 'opus' },
))))
dispatched.push('security')

/** Queues Miri when the workspace has unsafe code, or says it is skipped. */
function pushMiriDim() {
  if (hasUnsafe) {
    tasks.push(() => dispatchDim('miri', /** @type {Promise<FindingsResult | null>} */ (safeAgent(
      `This workspace contains unsafe code. Run its tests under Miri and report any undefined behavior against the rust-unsafe rubric (load the rust-unsafe skill). Return a verdict (Clean / UB-found), or "INCOMPLETE (not run)" if the nightly toolchain or miri itself is unavailable so nothing was executed under Miri — an unrun Miri is NOT Clean. Return findings.\n\nObservability: the rust-audit workflow records this run — do NOT write your own record.`,
      { label: 'miri', agentType: 'craft:rust-miri', phase: 'Audit', schema: FINDINGS_SCHEMA, model: 'opus' },
    ))))
    dispatched.push('miri')
  } else {
    log('No unsafe code detected — skipping Miri.')
  }
}
pushMiriDim()

// ---- Whole-project tool dimensions (D–G). Each runs its tools, interprets, and degrades
// gracefully: a missing tool/toolchain is a SKIP, never a hard failure — but a skip reports
// `INCOMPLETE (not run)`, not Approve. Approve stays reserved for "the tool ran and found
// nothing"; a reader of the dimension table must be able to tell those two apart. ----

tasks.push(() => dispatchDim('semver', /** @type {Promise<FindingsResult | null>} */ (agent(
  `Check public-API semver compatibility across the workspace's PUBLISHED crates. Run \`cargo semver-checks check-release\` (per published crate as needed). If \`cargo-semver-checks\` is not installed, say so and return verdict "INCOMPLETE (not run)" with a one-line note naming what was missing — do NOT fail, and do NOT return Approve: nothing was checked. If the tool IS available but there is no published library crate to check, that is a real, complete answer — return "Approve" with a note that the workspace publishes no library. Load the rust-ecosystem skill (semver/publishing) and the rust-review api-design pass. Report breaking changes vs the published baseline as findings. Fill the \`evidence\` field with one line beginning \`Evidence:\` naming the exact commands you ran and crates you checked this pass — a passing verdict with an empty evidence field is treated as INCOMPLETE, not trusted.`,
  { label: 'semver', phase: 'Audit', schema: FINDINGS_SCHEMA, effort: 'low' },
))))
dispatched.push('semver')

tasks.push(() => dispatchDim('build-matrix', /** @type {Promise<FindingsResult | null>} */ (agent(
  `Check the build across feature combinations and the MSRV. If \`cargo-hack\` is installed: \`cargo hack check --feature-powerset --no-dev-deps\`, plus \`cargo check --no-default-features\` and \`cargo check --all-features\`. For MSRV: read \`rust-version\` from Cargo.toml and run \`cargo hack --rust-version check\` (or \`cargo +<rust-version> check\` if that toolchain is installed). Skip any tool/toolchain that is absent with a note. If NOTHING could run, return verdict "INCOMPLETE (not run)" naming what was missing — do NOT fail, and do NOT return Approve: no feature combination was actually built. Return "Approve" only if at least one check ran and passed. Load the rust-ecosystem skill. Report failing feature combinations or MSRV breakage as findings. Fill the \`evidence\` field with one line beginning \`Evidence:\` naming the exact commands you ran (feature sets, MSRV checks) this pass — a passing verdict with an empty evidence field is treated as INCOMPLETE, not trusted.`,
  { label: 'build-matrix', phase: 'Audit', schema: FINDINGS_SCHEMA, effort: 'low' },
))))
dispatched.push('build-matrix')

tasks.push(() => dispatchDim('deps', /** @type {Promise<FindingsResult | null>} */ (agent(
  `Audit dependency HYGIENE (distinct from security vulns/licenses). Run \`cargo tree -d\` (duplicate/conflicting versions that bloat the build and binary) and \`cargo outdated\` (out-of-date deps). Do NOT check unused dependencies here — the \`unused-crates\` dimension owns that (with verification). Skip any tool that is not installed with a note — do NOT fail; but if NEITHER tool is installed, so no dependency hygiene was actually inspected, return verdict "INCOMPLETE (not run)" naming the missing tools rather than "Approve". Load the rust-ecosystem skill (dependency weight/hygiene). Report duplicates and notably out-of-date deps as findings. Fill the \`evidence\` field with one line beginning \`Evidence:\` naming the exact commands you ran (e.g. \`cargo tree -d\`, \`cargo outdated\`) this pass — a passing verdict with an empty evidence field is treated as INCOMPLETE, not trusted.`,
  { label: 'deps', phase: 'Audit', schema: FINDINGS_SCHEMA, effort: 'low' },
))))
dispatched.push('deps')

// Unused-crates dimension — detect, then ADVERSARIALLY VERIFY, two classes of dead weight:
//   (a) orphan workspace members — a workspace crate no other member depends on, that is not a
//       binary and not a published library;
//   (b) unused dependencies — deps declared in a Cargo.toml but never used (cargo machete/udeps).
// Both detectors are false-positive-prone (cfg/feature-gated, macro-only, re-exported, build.rs,
// dev/bench/example-only usage), so every candidate is verified before it reaches the report: a
// verifier tries HARD to prove the crate IS used and only the survivors are kept. Self-contained
// find→verify pipeline inside one thunk so it composes with the flat `parallel(tasks)` fan-out.
tasks.push(() => dispatchDim('unused-crates', (async () => {
  const found = /** @type {FindingsResult | null} */ (await agent(
    `Find UNUSED crates in this Rust workspace, in two classes:
(a) ORPHAN workspace members — from \`cargo metadata --format-version 1\`, workspace members that NO other workspace member depends on (any dependency kind), EXCLUDING binaries (a [[bin]] target or src/main.rs) and published libraries (Cargo.toml \`publish\` is not false / it is meant for crates.io).
(b) UNUSED dependencies — run \`cargo machete\` (or \`cargo +nightly udeps\` if machete is absent) to list dependencies declared in a Cargo.toml but not used.
Skip a tool that is not installed with a note — do NOT fail. \`cargo metadata\` alone answers class (a), so it is enough to run: if the graph loads and there are no orphan members, that is a real "Approve" with an empty findings list. But if \`cargo metadata\` itself does not run, so NOTHING was inspected, return verdict "INCOMPLETE (not run)" naming what was missing — not "Approve".
Load the rust-ecosystem skill (dependency / crate hygiene).
These are CANDIDATES, not confirmed — they will be verified downstream. Return one finding per candidate: title = "orphan-member: <crate>" or "unused-dep: <dep> in <crate>", location = the owning manifest path, detail = why the graph/tool thinks it is unused. Use severity Info (verification sets the real severity).`,
    { label: 'unused-crates:find', phase: 'Audit', schema: FINDINGS_SCHEMA, effort: 'low' },
  ))
  // A dead find-step nulls the whole dimension. Return the null and let dispatchDim log its reason
  // in the one place both sub-deaths are named — including a THROWN find-step, which rejects this
  // IIFE and is caught by dispatchDim's `.catch` (that is why the thunk is wrapped, not mapped inline).
  if (!found) return null
  const candidates = (Array.isArray(found.findings) ? found.findings : [])
    .filter(f => /^(orphan-member|unused-dep):/.test(f.title || ''))
  // No candidates: the find step IS the whole verification, and its verdict distinguishes a computed
  // clean (cargo metadata loaded, no orphans → a green) from a non-run (metadata absent → INCOMPLETE).
  // Like its sibling branches (unusedCratesResult, lines below), a computed-clean green is gated and so
  // must carry COMPUTED evidence — the find prompt has no `Evidence:` clause, so a self-reported empty
  // evidence field would falsely demote an honest clean pass. Inject the zero-candidate tally as the
  // evidence for a green; leave a non-run's own words intact (it is not gated, and claiming the
  // detectors ran would be false). (realm @nick/craft, node #53)
  if (!candidates.length) {
    const t = tallyVerification(candidates, [])
    const evidence = GREEN_VERDICT.test(String(found.verdict ?? '')) ? unusedEvidence(t) : (found.evidence ?? '')
    return { ...found, dimension: 'unused-crates', evidence, _verification: { candidates: 0, confirmed: 0, refuted: 0, died: 0, judged: 0, refuteRate: null } }
  }
  // Verify each candidate: prove it is USED. Default to "used" (drop it) when uncertain —
  // recommending deletion of live code is the costly error here.
  const verdicts = await parallel(candidates.map((c, i) => () =>
    /** @type {Promise<UnusedVerdict | null>} */ (agent(
      `A detector flagged a crate/dependency as UNUSED. Try HARD to REFUTE that — prove it IS used — before accepting it. Candidate: ${JSON.stringify(c)}.
Check the usages machete/udeps and the dependency graph miss: \`use\`/path references; cfg-gated and feature-gated usage; macro-only and re-exported (\`pub use\`) usage; build.rs / [build-dependencies]; [dev-dependencies] exercised only in tests, benches, or examples; and for an orphan member whether it is actually a bin, an example/bench/xtask, or consumed/published outside this workspace. Grep the source to confirm.
Set confirmedUnused=true ONLY if it is genuinely unused and safe to remove; default to false when uncertain.`,
      { label: `unused-crates:verify#${i + 1}`, phase: 'Verify', schema: UNUSED_VERDICT_SCHEMA, model: 'opus' },
    )).then(v => wrapVerdict(c, v)),
  ))
  return unusedCratesResult(candidates, verdicts)
})()))
dispatched.push('unused-crates')

/** The tests-cov brief's mutation-testing clause: run it only when asked. @returns {string} */
function mutantsInstruction() {
  return runMutants ? ' Run `cargo mutants --timeout 60`, time-boxed, to surface weak spots (it is slow).' : ' Do NOT run cargo mutants (not requested via {mutants:true}).'
}
tasks.push(() => dispatchDim('tests-cov', /** @type {Promise<FindingsResult | null>} */ (agent(
  `Assess test effectiveness and docs. Run \`cargo llvm-cov --summary-only\` (overall coverage + worst-covered files) if \`cargo-llvm-cov\` is installed.${mutantsInstruction()} Build docs cleanly: \`cargo doc --no-deps\` (flag broken intra-doc links) and run doctests (\`cargo test --doc\`). Skip any tool that is not installed with a note — do NOT fail; but if NONE of them ran (no coverage tool, no doc build, no doctests), return verdict "INCOMPLETE (not run)" naming the missing tools rather than "Approve" — nothing was measured. Load the rust-testing skill (coverage/mutation/doctests) and rust-idioms (rustdoc). Report low-coverage hotspots, surviving mutants, broken doc links, and failing doctests as findings. Fill the \`evidence\` field with one line beginning \`Evidence:\` naming the exact commands you ran (coverage, doc build, doctests) this pass — a passing verdict with an empty evidence field is treated as INCOMPLETE, not trusted.`,
  { label: 'tests-cov', phase: 'Audit', schema: FINDINGS_SCHEMA, effort: 'low' },
))))
dispatched.push('tests-cov')

// Normalise every dimension verdict ONCE, here, so the aggregate, the persisted record and the
// synthesis prompt all read the same vocabulary (reviewResult already normalised its own).
const results = (await parallel(tasks)).filter(r => !!r).map(r => ({ ...r, verdict: normalizeDimensionVerdict(r.verdict) }))

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
// with partial coverage — worstVerdict() keeps it red; it does not belong in either list.
// TWO reasons a dimension leads with INCOMPLETE, and they are NOT the same fact to a reader:
//   COULD NOT RUN — `INCOMPLETE (not run)`: the tooling was absent, so nothing was checked.
//   NO EVIDENCE   — `INCOMPLETE (no evidence …)`: demoteUnsupportedGreen demoted a claimed green that
//                   showed no `Evidence:` line. The tool may well have run — the agent just did not
//                   show its work — so asserting "tooling absent" of these would be inaccurate.
// Both still mark the audit INCOMPLETE (incompleteDimensions), but they are logged and framed apart.
const couldNotRun = results.filter(r => /^\s*INCOMPLETE \(not run\)/i.test(String(r.verdict || ''))).map(r => r.dimension)
const noEvidence = results.filter(r => /^\s*INCOMPLETE \(no evidence/i.test(String(r.verdict || ''))).map(r => r.dimension)
// incompleteDimensions is a SOFT catch-all — every dimension whose verdict LEADS with INCOMPLETE
// checked nothing, whatever the parenthetical. couldNotRun and noEvidence stay NARROW display buckets
// (tooling-absent vs green-with-no-evidence), but an off-canonical form — "INCOMPLETE (tooling
// absent)", "INCOMPLETE (not run: cargo-hack)", a bare "INCOMPLETE" — must not escape the ACCOUNTING
// the way those two narrow regexes let it: it would drop out of incompleteDimensions and auditVerdict
// would lose the `(INCOMPLETE)` suffix, filing a partially-covered audit as clean. This is the one
// soft reading worstVerdict (/INCOMPLETE/) and auditVerdict already use. (realm @nick/craft, node #53)
const incompleteDimensions = [...notRun, ...results.filter(r => /^\s*INCOMPLETE/i.test(String(r.verdict || ''))).map(r => r.dimension)]
/** Logs each kind of dimension that did not answer for its coverage. */
function logGaps() {
  if (notRun.length) log(`No result from: ${notRun.join(', ')} — flagged NOT RUN in the report.`)
  if (couldNotRun.length) log(`Tooling absent, nothing checked: ${couldNotRun.join(', ')} — flagged COULD NOT RUN in the report.`)
  if (noEvidence.length) log(`Reported a green but showed no Evidence: ${noEvidence.join(', ')} — flagged NO EVIDENCE (verdict not trusted) in the report.`)
}
logGaps()
/** @param {string[]} names @returns {string} */
const listOrNone = names => names.length ? names.join(', ') : 'none'

const stripped = results.map(stripInternal)

phase('Synthesize')
const report = await agent(
  `You are consolidating a Rust audit. Below are JSON results from independent review agents. Dimensions come in families: \`review:<crate>\` (one per crate reviewed), \`contract:<from>→<to>\` (one per inter-crate dependency edge), \`crate-decomposition\` (extract/merge recommendations), \`architecture\`, \`security\`, \`miri\`, and the tool dimensions \`semver\`/\`build-matrix\`/\`deps\`/\`unused-crates\` (verified orphan workspace members + unused dependencies)/\`tests-cov\`. Produce ONE markdown report — do not invent findings, only merge what is given:

1. An **overall verdict** line — the worst case across all dimensions. If any dimension did not run, or could not run, mark the audit INCOMPLETE.
2. A **dimension → verdict** table with one row per dimension present (list each \`review:<crate>\` and \`contract:<from>→<to>\` separately). Add a row for every dimension under NOT RUN below with verdict \`NOT RUN\` — its agent failed, so do not treat its absence as a pass. Any dimension listed under COULD NOT RUN below (verdict \`INCOMPLETE (not run)\`) must be rendered as \`COULD NOT RUN\` with a note naming the missing tool. Any dimension listed under NO EVIDENCE below (verdict \`INCOMPLETE (no evidence …)\`) must be rendered as \`NO EVIDENCE\` — it claimed a green but showed no work, so its verdict is not trusted; the tool may have run, so do NOT call it tooling-absent. NEVER render either as Approve or as a blank/green cell: a reader must be able to tell "ran, found nothing" from "never ran" from "claimed clean but showed nothing". Directly beneath the table, state in one line how many dimensions actually ran out of the total.
3. **Findings by severity** (Critical first), each tagged with its dimension and location, plus a one-line fix direction.
4. A short **"Fix first"** list — the few highest-leverage items across all dimensions.
5. A **"Crate boundaries"** note: summarise the \`crate-decomposition\` extract/merge recommendations (driver + boundary), if any.
6. If a \`review:*\` dimension's summary names a **gate provenance** (CI vs local), surface it in one line under the verdict.

NOT RUN (no result — agent failed or was skipped): ${listOrNone(notRun)}
COULD NOT RUN (agent reported back, but its tooling was absent so nothing was checked — treat as uncovered, never as a pass): ${listOrNone(couldNotRun)}
NO EVIDENCE (agent claimed a green but showed no work, so its verdict is not trusted — the tool may have run; treat as uncovered, never as a pass, but do NOT assert its tooling was absent): ${listOrNone(noEvidence)}

RESULTS:
${JSON.stringify(stripped, null, 2)}`,
  // Synthesis is merge/dedup/rank of given verdicts — moderate reasoning, not a deep judgement call.
  { label: 'synthesis', effort: 'medium' },
)

const uc = results.find(r => r.dimension === 'unused-crates')
/** The unused-crates verification as the record stores it, or null when that dimension did not verify. @param {DimResult | undefined} u */
function verificationRecord(u) {
  if (!u || !u._verification) return null
  const v = u._verification
  return {
    candidates: v.candidates,
    confirmed: v.confirmed,
    refuted: v.refuted ?? null,
    died: v.died ?? null,
    judged: v.judged ?? null,
    refuteRate: v.refuteRate ?? null,
  }
}
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
    const s = summarizeFindings(r['findings'])
    return { dimension: r['dimension'], verdict: r['verdict'], findingCount: s.total, bySeverity: s.bySeverity }
  }),
  // The rate is over what was JUDGED, not over the candidates: charging the deaths to the detector
  // is the same conflation the dimension's verdict was fixed for, and this record — not the console
  // report — is what analyze-runs averages into the "noisy lens" call. `refuted` and `died` ride
  // along so a reader can see the two apart; `refuteRate` keeps its name and its 0..1 range, so an
  // older reader keeps working (analyze-runs skips a non-number, which is what an unjudged run now
  // stores instead of a fabricated 0).
  verification: verificationRecord(uc),
  notRun,
  couldNotRun,
  noEvidence,
  // Agent types that were not registered (so their dimensions ran on the generic subagent) and
  // dispatches that came back empty and went generic, the nested reviews' included — realm
  // @nick/craft #116, #151, #153.
  ...agentRecord(),
  outputTokens: budget.spent(),
}
await logRun(auditRecord)

// The marker LEADS the report: a reader who is about to go look this audit up in the store has to
// learn here that it may not be there.
// `report` comes from an unguarded agent call, and every other agent result in this file is checked
// for death. Interpolating it turns a dead synthesizer into the literal four-character string "null",
// which reads as a successful audit with an empty body — and that is exactly the run where the
// telemetry marker is also empty, so nothing at all says the synthesis died.
// Without a schema a live agent returns its final text, so anything but a non-blank string is a death:
// a whitespace-only answer is no report either (realm @nick/craft, #136).
if (typeof report !== 'string' || !report.trim()) return `${telemetryLostSection(telemetryLost)}${agentSection()}⚠️ INCOMPLETE — the Synthesize agent returned no result, so this audit has NO report. Nothing here is an approval; re-run it.${nestedPriorDecisionsSection(results.map(r => ({ dimension: r.dimension, text: r._priorDecisions || '' })))}`
return `${telemetryLostSection(telemetryLost)}${agentSection()}${report}${nestedPriorDecisionsSection(results.map(r => ({ dimension: r.dimension, text: r._priorDecisions || '' })))}`
