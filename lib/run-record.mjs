// Canonical, tested helpers for building craft run records.
// NOTE: workflow scripts run sandboxed and cannot import — they inline VERBATIM copies of these
// functions. Keep the copies in workflows/rust-audit.js and workflows/rust-review.js in sync.

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

export function indexProjection(r) {
  return {
    schemaVersion: r.schemaVersion, ts: r.ts, kind: r.kind, name: r.name,
    project: r.project, commit: r.commit, dirty: r.dirty,
    verdict: r.verdict, findingsTotal: r.findings ? r.findings.total : 0,
    nested: r.nested, via: r.via, outputTokens: r.outputTokens ?? null,
  }
}
