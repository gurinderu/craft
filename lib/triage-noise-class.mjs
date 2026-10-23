// The validator's noise classes in triage-findings (realm @nick/craft, node #303), read back from its
// answer: "not this PR's" (class 1) is a deferral carried by an issue on the consumer's forge, and only
// when the validator opened the code at the base; "not decidable from the code" (class 5) a needs-decision.
// Inlined into src/triage-findings.js.

/** @typedef {{ severity: string, title: string, location: string, detail: string, source: string, stable_id: string }} IssueFinding */

/**
 * A validator's noise class (node #303), 0 when it named none or one outside 1..6.
 * @param {unknown} v @returns {number}
 */
export function noiseClassOf(v) {
  const n = v && typeof v === 'object' ? Number(/** @type {Record<string, unknown>} */ (v)['noise_class']) : 0
  return Number.isInteger(n) && n >= 1 && n <= 6 ? n : 0
}

/**
 * The verdict a noise class settles: class 1 (not this PR's) is a deferral carried by an issue on the
 * consumer's forge — but only when the validator recorded what it opened at the base, else nothing
 * settled it and a human decides; class 5 (not decidable from the code) is needs-decision. Every other
 * verdict stands as the validator gave it.
 * @template {{ verdict: string, reason: string, premise_checked: string }} V @param {V} v
 * @returns {V & { action?: string }}
 */
export function classifiedVerdict(v) {
  const n = noiseClassOf(v)
  if (n === 1 && !String(v.premise_checked ?? '').trim()) {
    return { ...v, verdict: 'needs-decision', reason: `claimed not this PR's, but nothing at the base was opened to show it — ${v.reason}` }
  }
  if (n === 1) return { ...v, verdict: 'defer', action: 'issue' }
  if (n === 5) return { ...v, verdict: 'needs-decision' }
  return v
}

/**
 * The issue a class-1 finding becomes: its title, and a body naming where it stands, why it is not this
 * PR's, and the source's own words.
 * @param {IssueFinding} f @param {{ reason: string, premise_checked: string }} v
 * @returns {{ stable_id: string, title: string, body: string }}
 */
export function issueOf(f, v) {
  return {
    stable_id: f.stable_id,
    title: f.title,
    body: [`${f.severity} · ${f.location || 'no location'} · from ${f.source}`, '', f.detail, '', `Not introduced by the PR it was raised on: ${v.reason} (checked at ${v.premise_checked})`].join('\n'),
  }
}
