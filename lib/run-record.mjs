// Canonical, tested helpers for building craft run records.
// NOTE: workflow scripts run sandboxed and cannot import — they inline VERBATIM copies of these
// functions. Keep the copies in workflows/rust-audit.js, workflows/rust-review.js and
// workflows/strict-review.js in sync.

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

export function worstVerdict(verdicts) {
  if (verdicts.some(v => /Block|At-risk|UB-found/i.test(v || ''))) return 'Block'
  if (verdicts.some(v => /Warning|Concerns/i.test(v || ''))) return 'Warning'
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
  return DISPOSITION_FROM_TRIAGE[v] || 'open'
}

// Re-review verdict: reviewVerdict over the findings that still matter this round. resolved and
// carried (rejected/justified) findings are excluded by the caller, so they never reach here.
export function rereviewVerdict({ stillOpen = [], regressed = [], neu = [] } = {}) {
  return reviewVerdict([...stillOpen, ...regressed, ...neu])
}

export function indexProjection(r) {
  return {
    schemaVersion: r.schemaVersion, runtime: r.runtime ?? null, ts: r.ts, kind: r.kind, name: r.name,
    project: r.project, commit: r.commit, dirty: r.dirty,
    verdict: r.verdict, findingsTotal: r.findings ? r.findings.total : 0,
    nested: r.nested, via: r.via, outputTokens: r.outputTokens ?? null,
  }
}
