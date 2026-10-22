// The light profile of craft:review, and the consumer's own agents run as extra lenses
// (realm @nick/craft, node #295).
//
// PURITY IS THE CONTRACT, as in lib/verify-economy.mjs: nothing here logs, dispatches or reads
// workflow state. It lives outside the workflow because workflows/review.js cannot be imported, and
// is pasted back in verbatim through a `craft-inline` fenced region.

// An unrecognised depth runs the full review: the cheaper pass is bought only by name.
/** @param {unknown} raw @returns {{ depth: 'full' | 'light', unknown: string }} */
export function parseDepth(raw) {
  if (raw == null || raw === '') return { depth: 'full', unknown: '' }
  const v = String(raw).trim().toLowerCase()
  if (v === 'light') return { depth: 'light', unknown: '' }
  return { depth: 'full', unknown: v === 'full' ? '' : String(raw).slice(0, 40) }
}

// The plan's lenses a light pass keeps: the diff-scoped ones. A whole-diff lens judges the change
// against the rest of the repository, which is the cost the light pass exists not to pay. When the
// plan held only whole-diff lenses, the profile's own diff-scoped roster stands in, so a light pass
// never dispatches nothing. `forced` lenses run whatever the plan held, whole-diff or not.
/**
 * @param {string[]} lenses
 * @param {readonly string[]} wholeDiff
 * @param {string[]} fallback
 * @param {string[]} [forced]
 * @returns {{ kept: string[], skipped: string[] }}
 */
export function lightLenses(lenses, wholeDiff, fallback, forced = []) {
  /** @param {string} l */
  const scoped = l => !wholeDiff.includes(l) || forced.includes(l)
  const kept = lenses.filter(scoped)
  return { kept: [...new Set([...(kept.length ? kept : fallback.filter(scoped)), ...forced])], skipped: lenses.filter(l => !scoped(l)) }
}

// The lenses a light pass never drops when the diff changes production code: `tests`, the coverage
// adversary with the deletion litmus, and `intent`, whole-diff but the one that catches a test asserting
// nothing (both sides hardcoded, cases that vary nothing the code reads). Tests for show are exactly what
// a cheap pass must not wave through.
export const LIGHT_FORCED_LENSES = ['tests', 'intent']

// A test file by its path: a test directory, or a test-shaped file name.
/** @param {unknown} f @returns {boolean} */
export function isTestPath(f) {
  const p = String(f ?? '')
  return /(^|\/)(tests?|__tests__|testdata|fixtures|benches)\//i.test(p) || /(^|\/)(test_[^/]*|[^/]*[._-](test|tests|spec))\.[a-z0-9]+$/i.test(p)
}

// The forced lenses the profile's roster offers, when any file it covers outside the tests changed.
/** @param {string[]} files @param {(fs: string[]) => boolean} detect @param {string[]} roster @returns {string[]} */
export function lightForcedLenses(files, detect, roster) {
  return files.some(f => detect([f]) && !isTestPath(f)) ? LIGHT_FORCED_LENSES.filter(l => roster.includes(l)) : []
}

/** @type {readonly (string | undefined)[]} */
export const LIGHT_VERIFIED_SEVERITIES = ['Critical', 'High', 'Medium']

// A light pass verifies Medium and above only: below that a finding passes unverified, whatever
// rule it cites -- the full profile's escape hatch for a mislabelled blocking rule is a full-pass cost.
/** @param {string} tier @param {string | undefined} severity @param {string} depth @returns {string} */
export function depthVerifyTier(tier, severity, depth) {
  return depth === 'light' && !LIGHT_VERIFIED_SEVERITIES.includes(severity) ? 'skip' : tier
}

/** @param {string | undefined} severity */
export function lightUnverifiedWhy(severity) {
  return `light pass: only Medium and above are verified, so no verifier was spent on this ${severity || 'unrated'} finding and nothing here has been checked against the code`
}

// Amends the first line under `## Verdict` so the verdict itself says what kind of pass made it;
// a report with no verdict heading gets the mark as its first line.
/** @param {string} text @returns {string} */
export function markVerdictLight(text) {
  const lines = String(text).split('\n')
  const head = lines.findIndex(l => /^#+\s*Verdict\b/i.test(l.trim()))
  const at = head < 0 ? -1 : lines.findIndex((l, i) => i > head && l.trim())
  if (at < 0) return `Light pass (depth=light) -- see "Light pass" below for what it skipped.\n${text}`
  if (/light pass/i.test(/** @type {string} */ (lines[at]))) return text
  lines[at] = `${lines[at]} \u00b7 light pass (depth=light) -- see "Light pass" below for what it skipped`
  return lines.join('\n')
}

// What the light pass did not do, stated mechanically on every report it returns.
/** @param {string[]} skippedLenses @param {boolean} [lensesRan] false on an exit before any lens ran @returns {string} */
export function lightSection(skippedLenses, lensesRan = true) {
  if (!lensesRan) return `\n\n## Light pass -- no lens ran\n\u26a0\ufe0f This was a LIGHT pass (depth=light), and it ended before any lens ran, so it makes no statement about the code. Re-run once the cause above is fixed.\n`
  const lenses = skippedLenses.length
    ? `the whole-diff lenses ${skippedLenses.join(', ')} were NOT dispatched (tests and intent still run whenever the diff changes production code)`
    : 'no whole-diff lens was in the plan to skip'
  return `\n\n## Light pass -- what it skipped\n\u26a0\ufe0f This was a LIGHT pass (depth=light), not a full review, and its verdict covers only what it ran: ${lenses}; the lenses ran ONE round (no loop-until-dry); the completeness critic did not run; Low and Info findings were not verified (each says so in its \`why\`). That is an absence of a result, not a clean one. Re-run without \`depth\` (or with \`depth=full\`) for the full review.\n`
}
