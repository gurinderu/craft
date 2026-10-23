// The validator's noise classes in triage-findings (realm @nick/craft, node #303), read back from its
// answer: "not this PR's" (class 1) on a real finding is a deferral carried by an issue on the consumer's
// forge, and only when premise_checked names the code opened at the base the triage was given —
// `git show <that base>:<path>`, that base and no other ref (node #309): a premise naming HEAD, another
// ref or only the word merge-base has shown nothing, and with no base given nothing can be shown; else a
// human decides. Only an `accept` or a `defer` turns into that deferral: a class-1 `reject` is not a real
// problem and files nothing, a class-1 `needs-decision` still waits on a human.
// "Not decidable from the code" (class 5) is a needs-decision.
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
 * What the validator is told about where class 1 must be shown: the base this triage was given, cited
 * exactly as `classifiedVerdict` reads it, so the engine can tell the premise opened that base rather
 * than a ref the validator picked (node #309); with no base, that a human decides.
 * @param {string} base @returns {string}
 */
export function classOneBaseLine(base) {
  const at = String(base ?? '').trim()
  return at
    ? `the base is \`${at}\` — open the cited code there and record in premise_checked exactly \`git show ${at}:<path>\`; a premise naming any other ref (HEAD, a branch, a merge-base you computed) reads as unchecked and goes to a human`
    : 'no base was given to this triage, so it cannot be checked here — name the class all the same; a human decides it'
}

/**
 * Whether a premise shows a file opened at exactly `base`: `git show <base>:<path>`, the ref ending at
 * the colon, so neither another ref nor one that only starts with the base passes.
 * @param {string} premise @param {string} base @returns {boolean}
 */
export function openedAt(premise, base) {
  const ref = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|\\s)git show ${ref}:[^\\s:]`).test(premise)
}

/**
 * The verdict a noise class settles: class 1 (not this PR's) on a finding the validator accepted or
 * deferred is a deferral carried by an issue on the consumer's forge — but only when premise_checked
 * shows a file opened at `base` — the triage's own base, never a ref the validator picked — else nothing
 * settled it and a human decides; with no base given, always a human. Any other class-1 verdict stands
 * (a `reject`: no real problem, no issue; a `needs-decision`: still the human's). Class 5 (not
 * decidable from the code) is needs-decision. Every other verdict stands as the validator gave it.
 * @template {{ verdict: string, reason: string, premise_checked: string }} V @param {V} v
 * @param {string} [base] the ref the triage was given to check against; '' or absent when none
 * @returns {V & { action?: string }}
 */
export function classifiedVerdict(v, base = '') {
  const n = noiseClassOf(v)
  if (n === 1) return notThisPrs(v, String(base ?? '').trim())
  if (n === 5) return { ...v, verdict: 'needs-decision' }
  return v
}

/**
 * A class-1 verdict settled: a real problem shown at `base` is a deferral with an issue, one not shown
 * there a human's; a `reject` or `needs-decision` stands.
 * @template {{ verdict: string, reason: string, premise_checked: string }} V @param {V} v @param {string} base
 * @returns {V & { action?: string }}
 */
export function notThisPrs(v, base) {
  if (v.verdict !== 'accept' && v.verdict !== 'defer') return v
  if (!base) return { ...v, verdict: 'needs-decision', reason: `claimed not this PR's, but no base was given to check it at — ${v.reason}` }
  if (!openedAt(String(v.premise_checked ?? ''), base)) {
    return { ...v, verdict: 'needs-decision', reason: `claimed not this PR's, but nothing at the base ${base} was opened to show it — ${v.reason}` }
  }
  return { ...v, verdict: 'defer', action: 'issue' }
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
