// The review's pool before verification (src/review.js, Verify phase): the mechanical roll-up of low-value rule
// floods, and the cross-lens dedup that merges one defect worded by several lenses.
import { isToolSource, holdsToolDistinct } from './prior-decision-match.mjs'
import { pathFloorNote } from './path-severity-floor.mjs'
import { withEarliestRound } from './lens-round-yield.mjs'
import { sameSpotGroups } from './review-same-spot.mjs'
import { mergedHarmClaims } from './lens-agreement.mjs'
import { mergeComponents, noteComponents, COMPONENT_MAX } from './dedup-components.mjs'

/**
 * @typedef {import('./review-schemas.mjs').Finding} Finding
 * @typedef {import('./review-profiles.mjs').Profile} Profile
 * @typedef {import('./review-schemas.mjs').DedupAnswer} DedupAnswer
 * @typedef {import('./review-run.mjs').ReviewRun} ReviewRun
 */
/**
 * @template T
 * @typedef {import('./review-schemas.mjs').Schema<T>} Schema
 */
// The round that first found a finding, and what each round's findings became (realm @nick/craft, node #248).
// Mechanical roll-up of high-volume, low-value rule IDs. The api-idioms lens brief already ASKS for
// this ("do NOT file one finding per occurrence — roll repeated instances into ONE finding"), and the
// run store shows it is not obeyed: one lens produced 126 confirmed findings over 21 runs, 100 of
// them Low/Info. An instruction the model can quietly skip is not a cap; this is. The excess is
// folded into the representative finding rather than dropped, and the count is stated in the title
// and logged — a silent truncation would read as "there were only N", which is worse than the flood.
export const ROLLUP_MAX = 3

/**
 * The roll-up and the dedup of one run.
 * @param {ReviewRun} reviewRun
 */
export function makeDedup(reviewRun) {
const { SEV_RANK, ragent, dedupComponents } = reviewRun
const { log: logLine } = reviewRun.sb

// Cross-lens dedup BEFORE verification. key() above is exact (file:line:title), so two lenses
// wording the same defect differently both enter the pool — and each duplicate would buy its own
// verifier fan-out. A cheap grouping pass merges same-defect findings first; synthesis keeps its
// own dedup instruction as a safety net.
/** @type {Schema<DedupAnswer>} */
const DEDUP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['groups'],
  properties: {
    groups: {
      type: 'array',
      items: { type: 'array', items: { type: 'integer' } },
      description: 'each inner array = indices of findings that describe the SAME underlying defect; singletons omitted; empty if all distinct',
    },
  },
}
/** @param {Finding[]} pool @param {Profile} profile */
function rollupPool(pool, profile) {
  const ids = profile.rollupRuleIds || []
  if (!ids.length) return pool
  const { groups, out: rolled } = rollupGroups(pool, ids)
  for (const [, g] of groups) rolled.push(...rolledUp(g, profile))
  return rolled
}

/**
 * The pool split into findings a roll-up rule names, grouped by lens and rule, and the rest in order.
 * @param {Finding[]} pool @param {string[]} ids @returns {{ groups: Map<string, Finding[]>, out: Finding[] }}
 */
function rollupGroups(pool, ids) {
  /** @type {Map<string, Finding[]>} */
  const groups = new Map()
  const loose = []
  for (const f of pool) {
    const id = f['ruleId'] || ''
    if (!ids.includes(id)) { loose.push(f); continue }
    const k = `${f['source'] || ''}::${id}`
    let g = groups.get(k)
    if (!g) { g = []; groups.set(k, g) }
    g.push(f)
  }
  return { groups, out: loose }
}

/** A finding's severity rank, unknown severities last. @param {Finding} f */
function sevRankOf(f) {
  return SEV_RANK[f['severity'] ?? ''] ?? 9
}

/** One roll-up group as it enters the pool: as is up to ROLLUP_MAX, else the worst ROLLUP_MAX and one folded finding. @param {Finding[]} g @param {Profile} profile @returns {Finding[]} */
function rolledUp(g, profile) {
  // Order by severity so the representative is the worst instance, not an arbitrary one.
  const sorted = g.slice().sort((/** @type {Finding} */ a, /** @type {Finding} */ b) => sevRankOf(a) - sevRankOf(b))
  if (sorted.length <= ROLLUP_MAX) return sorted
  const keep = sorted.slice(0, ROLLUP_MAX)
  const folded = sorted.slice(ROLLUP_MAX)
  const rep = /** @type {Finding} */ (folded[0])   // folded is non-empty: sorted.length > ROLLUP_MAX
  const where = folded.slice(0, 6).map((/** @type {Finding} */ f) => `${f['file'] || '?'}:${f['line'] || 0}`).join(', ')
  const rolled = [...keep, withEarliestRound({
    ...rep,
    title: `${rep.title} — and ${folded.length - 1} more of the same (${rep.ruleId})`,
    why: `${rep.why} Repeated ${folded.length} more times across the diff (${where}${folded.length > 6 ? ', …' : ''}); rolled into one finding because per-occurrence reporting of this rule buries the rest of the review. Fix the pattern, not the instance.`,
  }, folded)]
  logLine(`[${profile.id}] Roll-up: ${g.length}× ${rep.ruleId} from '${rep.source}' → ${keep.length} individual + 1 grouped`)
  return rolled
}

/** The model's same-defect groups over the listed pool, or null when the pass failed (logged). @param {Profile} profile @param {string} listing */
async function dedupModelGroups(profile, listing) {
  let res = null
  try {
    res = await ragent(
      `You are deduplicating code-review findings BEFORE verification. Different lenses word the same defect differently. Group ONLY findings that describe the SAME underlying defect: ONE edit fixes all of them (e.g. one redundant loop reported by both a performance and an idioms lens). File and line are only a hint — two distinct defects can share a line, and one defect can be reported at different lines or files. Never group two defects because they sit together. When in doubt, do NOT group.

FINDINGS:
${listing}

Return {groups: [[i, j, ...], ...]} — index groups of same-defect findings; omit singletons; {groups: []} if all are distinct.`,
      { label: `dedup:${profile.id}`, phase: 'Verify', schema: DEDUP_SCHEMA, model: 'haiku', effort: 'low' },
    )
  } catch (e) {
    logLine(`[${profile.id}] dedup pass failed (${String((e && /** @type {{ message?: unknown }} */ (e).message) || e).slice(0, 80)}) — verifying the raw pool`)
  }
  return res
}

/** One same-defect group merged onto its strictest member. @param {Finding[]} members @param {(f: Finding) => boolean} isToolSrc @returns {Finding} */
function mergedGroup(members, isToolSrc) {
  // Base = the strictest member: tool-sourced first (a tool finding can only be refuted by
  // re-running the tool), then highest severity.
  const base = /** @type {Finding} */ (members.slice().sort((a, b) => (/** @type {number} */ (/** @type {unknown} */ (isToolSrc(b))) - /** @type {number} */ (/** @type {unknown} */ (isToolSrc(a)))) || ((SEV_RANK[a['severity'] ?? ''] ?? 9) - (SEV_RANK[b['severity'] ?? ''] ?? 9)))[0])
  const others = members.filter(m => m !== base)
  // A floored member keeps the group at Medium even when a lower tool-sourced finding is the base,
  // with the floor's note. Only the floor lifts: any other higher member leaves the base as it was,
  // because a tool base is refuted only by re-running the tool and must not carry a lens's claim.
  const sevOf = (/** @type {Finding} */ m) => SEV_RANK[m['severity'] ?? ''] ?? 9
  const floored = members.find(m => pathFloorNote(m['why']) !== '' && sevOf(m) < sevOf(base))
  const lifted = floored && sevOf(base) > (SEV_RANK['Medium'] ?? 2) ? { severity: 'Medium', why: `${base['why']}${pathFloorNote(floored['why'])}` } : {}
  // Carry ALL contributing sources so a downstream source-keyed rule (strict maintainability
  // escalation) still fires when its trigger lens was merged into a different-source base.
  // A member's own `sources` (an exact copy another lens filed, lib/lens-agreement.mjs) count too.
  const sources = [...new Set(members.flatMap(m => [m['source'], ...(Array.isArray(m['sources']) ? m['sources'] : [])]).filter(Boolean))]
  // Union the off-site evidence too: a merged-away member may have pinned the premise the base
  // only asserted, and dropping it would cost the group its Confirmed tier at verification.
  const whereChecked = [...new Set(members.map(m => m['whereChecked']).filter(Boolean))].join('; ')
  const merged = { ...base, ...lifted, ...mergedHarmClaims(base, members) }
  return withEarliestRound({ ...merged, sources, whereChecked, why: `${merged['why']} (same defect also reported by: ${others.map(m => m['source']).join(', ')})` }, members)
}

/** @param {Finding[]} pool @param {Profile} profile */
async function dedupPool(pool, profile) {
  if (pool.length < 2) return pool
  const isToolSrc = (/** @type {Finding} */ f) => isToolSource(f['source'])
  const listing = pool.map((/** @type {Finding} */ f, /** @type {number} */ i) => `${i}. ${f['file'] || '?'}:${f['line'] || 0} [${f['severity']}] (${f['source']}) ${f['title']} — ${String(f['why'] || '').slice(0, 160)}`).join('\n')
  const res = await dedupModelGroups(profile, listing)
  // Same-spot groups and the model's groups are edges of one graph; each connected component is one
  // finding (lib/dedup-components.mjs, realm @nick/craft, node #405).
  const detGroups = sameSpotGroups(pool)
  const at = (/** @type {number[]} */ g) => g.map(i => /** @type {Finding} */ (pool[i]))
  const modelGroups = (res?.groups ?? []).filter(g => Array.isArray(g) && g.length > 1 && g.every(i => Number.isInteger(i) && i >= 0 && i < pool.length))
    // Nor may the model merge them (realm @nick/craft, node #238).
    .filter(g => !holdsToolDistinct(at(g)))
  const { groups, fellBack, sizes } = mergeComponents(pool.length, detGroups, modelGroups, g => holdsToolDistinct(at(g)))
  if (dedupComponents) noteComponents(dedupComponents, sizes, fellBack.length)
  for (const c of fellBack) logLine(`[${profile.id}] dedup: a component of ${c.length} findings was not merged whole (over ${COMPONENT_MAX}, or tool-distinct members) — its groups merged first-wins`)
  const merged = groups.map(g => mergedGroup(at(g), isToolSrc))
  const inGroup = new Set(groups.flat())
  if (!merged.length) return pool
  const foldedPool = pool.filter((/** @type {Finding} */ _f, /** @type {number} */ i) => !inGroup.has(i)).concat(merged)
  const detFolded = detGroups.reduce((n, g) => n + g.length - 1, 0)
  logLine(`[${profile.id}] Dedup before verify: ${pool.length} → ${foldedPool.length} (${pool.length - foldedPool.length} cross-lens duplicate(s) merged — ${detFolded} of them same-spot, caught deterministically)`)
  return foldedPool
}
return { rollupPool, dedupPool }
}
