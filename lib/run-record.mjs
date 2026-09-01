// Canonical, tested helpers for building craft run records.
// NOTE: workflow scripts run sandboxed and cannot import — they inline VERBATIM copies of these
// functions. The copies are DERIVED, not maintained by hand: each sits between
// `// >>> craft-inline lib/run-record.mjs <names…>` and `// <<< craft-inline` fences, and
// `node lib/check-workflows.mjs` regenerates the region from this file and fails on any difference.
// A declaration mirrored into a workflow therefore travels with its leading `//` comment block —
// reword one here and the gate will tell you which copies to regenerate (see lib/inline-regions.mjs).

export const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Info']

export function countBySeverity(findings) {
  const by = { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 }
  for (const f of (Array.isArray(findings) ? findings : [])) {
    if (f && Object.prototype.hasOwnProperty.call(by, f.severity)) by[f.severity] += 1
  }
  return by
}

export function summarizeFindings(findings) {
  const bySeverity = countBySeverity(findings)
  return { total: SEVERITIES.reduce((n, s) => n + bySeverity[s], 0), bySeverity }
}

// An UNRECOGNISED verdict must never default to the most permissive outcome: an aggregate that
// turns `INCOMPLETE (no language profile)` back into `Approve` re-creates, one layer up, exactly the
// overclaim the leaf verdicts were fixed to avoid. Anything that is not a verdict we can read as
// green — INCOMPLETE included — aggregates to Warning.
export function worstVerdict(verdicts) {
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

export function reviewVerdict(confirmed) {
  const by = countBySeverity(confirmed)
  if (by.Critical || by.High) return 'Block'
  if (by.Medium) return 'Warning'
  return 'Approve'
}

// Triage produces per-finding dispositions, not a severity verdict. Tally a ledger/validation list
// (each entry `{verdict}`) into the fixed disposition buckets; unknown/malformed verdicts are dropped.
export const TRIAGE_VERDICTS = ['accept', 'reject', 'defer', 'needs-decision', 'conflict']

export function tallyVerdicts(entries) {
  const t = { accept: 0, reject: 0, defer: 0, 'needs-decision': 0, conflict: 0 }
  for (const e of (Array.isArray(entries) ? entries : [])) {
    if (e && Object.prototype.hasOwnProperty.call(t, e.verdict)) t[e.verdict] += 1
  }
  return t
}

// Fraction of candidates that did NOT survive, i.e. (candidates - confirmed) / candidates.
// Use only where every non-confirmed candidate is genuinely refuted (e.g. rust-audit's
// unused-crates, which has no "suspected" middle tier). rust-review computes its own rate as
// dropped/total instead, because there `confirmed` excludes a "suspected" tier that is NOT refuted.
export function refuteRate(candidates, confirmed) {
  const c = Number(candidates) || 0
  const k = Number(confirmed) || 0
  if (c <= 0) return 0
  return Math.round(((c - k) / c) * 100) / 100
}

// Normalized, word-order-independent word-set of a finding title. Used inside the fingerprint and
// for fuzzy cross-round matching so a lightly reworded title still matches its prior-round twin.
export function titleShingle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ')
}

// Line-tolerant finding identity: hash of file + enclosing symbol + ruleId + title shingle.
// djb2 (not crypto) — the sandbox has no crypto and bans Math.random, and we only need a stable,
// collision-resistant-enough key, computed identically in the lib and in the workflow mirror.
export function fingerprint(f) {
  const basis = [f?.file || '', f?.symbol || '', f?.ruleId || '', titleShingle(f?.title)].join('\0')
  let h = 5381
  for (let i = 0; i < basis.length; i++) h = ((h << 5) + h + basis.charCodeAt(i)) >>> 0
  return h.toString(16).padStart(8, '0')
}

export function shingleOverlap(a, b) {
  const sa = new Set(titleShingle(a).split(' ').filter(Boolean))
  const sb = new Set(titleShingle(b).split(' ').filter(Boolean))
  if (!sa.size || !sb.size) return 0
  let inter = 0
  for (const w of sa) if (sb.has(w)) inter++
  return inter / Math.max(sa.size, sb.size)
}

// True when `cur` (a freshly located finding) is the same defect as `prior` (from the ledger).
// file + ruleId must match exactly; a symbol mismatch only disqualifies when BOTH carry one (a
// finding can move symbols across a fix, so an absent symbol is not a veto); titles must overlap.
export function matchesPrior(cur, prior, { threshold = 0.6 } = {}) {
  if ((cur?.file || '') !== (prior?.file || '')) return false
  if ((cur?.ruleId || '') !== (prior?.ruleId || '')) return false
  if ((cur?.symbol || '') && (prior?.symbol || '') && cur.symbol !== prior.symbol) return false
  return shingleOverlap(cur?.title, prior?.title) >= threshold
}

// A ledger disposition sourced from a human triage decision. accept/needs-decision/conflict stay
// `open` (still to be adjudicated or fixed); only reject/defer carry a settled disposition.
export const DISPOSITION_FROM_TRIAGE = { reject: 'rejected', defer: 'deferred', accept: 'open', 'needs-decision': 'open', conflict: 'open' }
export function dispositionFromTriage(v) {
  return Object.prototype.hasOwnProperty.call(DISPOSITION_FROM_TRIAGE, v) ? DISPOSITION_FROM_TRIAGE[v] : 'open'
}

// Re-review verdict: reviewVerdict over the findings that still matter this round. resolved and
// carried (rejected/justified) findings are excluded by the caller, so they never reach here.
export function rereviewVerdict({ stillOpen = [], regressed = [], neu = [] } = {}) {
  return reviewVerdict([...stillOpen, ...regressed, ...neu])
}

export function indexProjection(r) {
  return {
    schemaVersion: r.schemaVersion, runtime: r.runtime ?? null, ts: r.ts, kind: r.kind, name: r.name,
    // craftVersion/craftCommit must ride in the INDEX, not just the detail file: the whole point is
    // filtering an aggregate down to one engine version, and that is done by scanning index.jsonl.
    craftVersion: r.craftVersion ?? null, craftCommit: r.craftCommit ?? null,
    project: r.project, commit: r.commit, dirty: r.dirty,
    branch: r.branch ?? null, head: r.head ?? null, round: r.round ?? 0,
    verdict: r.verdict, findingsTotal: r.findings ? r.findings.total : 0,
    nested: r.nested, via: r.via, outputTokens: r.outputTokens ?? null,
  }
}

// All prior `review` runs for this project+branch from the loaded index.jsonl entries, NEWEST FIRST.
// ts strings are UTC and lexically sortable (YYYY-MM-DDTHH-MM-SSZ), so a string sort is chronological.
// Callers walk this list: a candidate can be rejected downstream (head no longer an ancestor after a
// rebase, unreadable detail record) and the next-newest must still be reachable.
export function selectPriorRounds(indexEntries, { project, branch }) {
  const hits = []
  for (const e of (Array.isArray(indexEntries) ? indexEntries : [])) {
    if (!e || e.kind !== 'workflow' || e.name !== 'review') continue
    if (e.project !== project || e.branch !== branch || !e.branch) continue
    hits.push(e)
  }
  return hits.sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
}

// ---- engine identity -------------------------------------------------------------------------
// A DISCRIMINATOR the version string cannot supply. `craftVersion` names a RELEASE, not a
// behaviour: per-run rigor (maxRounds/verifyVotes/lensModel) moved from a model's unbounded answer
// to a fixed in-code table INSIDE the 0.16.0 window, so records of both engines carry the identical
// string and only a timestamp — which nobody reading a report has — separates them. A before/after
// built on that filter is unsound and reads exactly like a sound one.
//
// So: a monotonic integer, bumped BY HAND whenever the engine's behaviour changes in a way that
// changes what its telemetry MEANS — rigor constants, the verification protocol, the lens roster,
// the severity rubric, how findings are counted. Cosmetics, prompt wording that does not move the
// numbers, and pure refactors do not bump it.
//
// TRADE-OFF, stated plainly: nothing can enforce the bump. No gate can tell a behavioural change
// from a cosmetic one, so the number is only as honest as the person editing the engine — and a
// MISSED bump asserts sameness, where a missing field would merely have admitted ignorance. Two
// consequences follow, and both are deliberate: the reading side (lib/analyze-runs.mjs) treats an
// ABSENT revision as an unknown engine rather than folding it in with the current one; and the
// stronger alternative — fingerprinting the behavioural constants a run actually used, which cannot
// be forgotten — is not what ships here, because the engine does not report those constants in the
// record (only `scout` echoes some of them) and inventing that reporting means editing the workflow
// scripts. When it does report them, this integer should give way to that fingerprint.
//
// WHO MAINTAINS IT: whoever changes engine behaviour, in the same commit as the change. Log:
//   1 — every engine up to and including the one that asked Scout for its own rigor budget.
//   2 — rigor derived in code from the size bucket (RIGOR_BY_SIZE); a dead scout reads INCOMPLETE.
export const ENGINE_REVISION = 2

// The identity a before/after comparison may be sliced on. RUNTIME is part of it: `claude-code` and
// `opencode` are two different engines writing into one store, and the opencode adapter stamps no
// craftVersion at all — folding them together would be the same overclaim one level up.
// A record with no revision is `r?` — NOT revision 2: absence of the discriminator is ignorance
// about which engine ran, never evidence that it was this one.
export function engineKey(r) {
  const runtime = (r && r.runtime) || 'unknown-runtime'
  const version = (r && r.craftVersion) || 'unversioned'
  const rev = r && Number.isInteger(r.engineRevision) ? `r${r.engineRevision}` : 'r?'
  return `${runtime} ${version} ${rev}`
}

export function isEngineAttributed(r) {
  return !!(r && Number.isInteger(r.engineRevision))
}

