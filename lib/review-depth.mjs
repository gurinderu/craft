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
// never dispatches nothing.
/**
 * @param {string[]} lenses
 * @param {readonly string[]} wholeDiff
 * @param {string[]} fallback
 * @returns {{ kept: string[], skipped: string[] }}
 */
export function lightLenses(lenses, wholeDiff, fallback) {
  /** @param {string} l */
  const scoped = l => !wholeDiff.includes(l)
  const kept = lenses.filter(scoped)
  return { kept: kept.length ? kept : fallback.filter(scoped), skipped: lenses.filter(l => !scoped(l)) }
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
/** @param {string[]} skippedLenses @returns {string} */
export function lightSection(skippedLenses) {
  const lenses = skippedLenses.length
    ? `the whole-diff lenses ${skippedLenses.join(', ')} were NOT dispatched`
    : 'no whole-diff lens was in the plan to skip'
  return `\n\n## Light pass -- what it skipped\n\u26a0\ufe0f This was a LIGHT pass (depth=light), not a full review, and its verdict covers only what it ran: ${lenses}; the lenses ran ONE round (no loop-until-dry); the completeness critic did not run; Low and Info findings were not verified (each says so in its \`why\`). That is an absence of a result, not a clean one. Re-run without \`depth\` (or with \`depth=full\`) for the full review.\n`
}
