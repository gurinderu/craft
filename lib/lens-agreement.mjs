// Multi-lens agreement: two or more different lenses that report the same defect independently —
// merged into one finding by the cross-lens dedup before verification (lib/review-dedup.mjs, its
// `sources`) — buy that finding a verifier whatever severity its copies were filed at, when the harm
// it names could make it must-fix. Agreement buys verification only; severity is raised by a harm the
// verifier confirmed, never by the number of lenses (lib/harm-verify.mjs, realm @nick/craft, node #407).
import { isToolSource } from './prior-decision-match.mjs'
import { effectiveLevel } from './harm-cap.mjs'
import { claimsOf, groupClaims, harmRank } from './harm-verify.mjs'

/** How many different lenses make an agreement. */
export const LENS_AGREEMENT_MIN = 2

/**
 * The different lenses (not tools: a gate seed is not an independent reading) that reported `f`.
 * @param {{ source?: unknown, sources?: unknown }} f
 * @returns {string[]}
 */
export function agreeingLenses(f) {
  const all = Array.isArray(f.sources) ? f.sources : [f.source]
  return [...new Set(all.filter(s => typeof s === 'string' && s !== '' && !isToolSource(s)))]
}

/**
 * Whether two or more different lenses reported `f`.
 * @param {{ source?: unknown, sources?: unknown }} f
 */
export function lensAgreed(f) {
  return agreeingLenses(f).length >= LENS_AGREEMENT_MIN
}

/**
 * The harm fields a merged group carries: every distinct harm its lenses claimed (`harmClaims`, worst
 * first, for the verifier to judge), and as the shown harm the worst claim when it is worse than the
 * base's. A tool base carries no lens's claim.
 * @param {Record<string, unknown>} base
 * @param {Array<Record<string, unknown>>} members
 * @returns {{ harmClaims?: Array<{ harmLevel: string, harm?: string }>, harmLevel?: string, harm?: string, repoRule?: unknown }}
 */
export function worstHarmOf(base, members) {
  if (isToolSource(base['source'])) return {}
  const lenses = members.filter(m => !isToolSource(m['source']))
  const claims = groupClaims(lenses)
  /** @type {{ harmClaims?: Array<{ harmLevel: string, harm?: string }>, harmLevel?: string, harm?: string, repoRule?: unknown }} */
  const out = claims.length > 1 ? { harmClaims: claims } : {}
  const worst = lenses.reduce((a, m) => (harmRank(effectiveLevel(m)) < harmRank(effectiveLevel(a)) ? m : a), base)
  if (worst === base) return out
  if (typeof worst['harmLevel'] === 'string') out.harmLevel = worst['harmLevel']
  if (typeof worst['harm'] === 'string') out.harm = worst['harm']
  if (worst['repoRule'] !== undefined) out.repoRule = worst['repoRule']
  return out
}

/**
 * Records on `kept` that another lens filed the very same finding (same file, line and title), which
 * the pool's exact-key check otherwise drops without a trace: `kept.sources` gains the copy's source,
 * and `kept.harmClaims` the copy's claimed harm when it differs.
 * @param {Record<string, unknown> | undefined} kept  the pooled finding, mutated
 * @param {Record<string, unknown>} copy
 */
export function noteExactCopy(kept, copy) {
  if (!kept || typeof copy['source'] !== 'string' || copy['source'] === '' || copy['source'] === kept['source']) return
  const had = Array.isArray(kept['sources']) ? kept['sources'] : [kept['source']]
  if (!had.includes(copy['source'])) kept['sources'] = [...had, copy['source']]
  const claims = groupClaims([kept, copy])
  if (claims.length > claimsOf(kept).length) kept['harmClaims'] = claims
}
