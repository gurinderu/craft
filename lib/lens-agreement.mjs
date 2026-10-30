// Multi-lens agreement: two or more different lenses that report the same defect independently —
// merged into one finding by the cross-lens dedup before verification (lib/review-dedup.mjs, its
// `sources`) — buy that finding a verifier whatever severity its copies were filed at, when the harm
// it names could make it must-fix. Agreement buys verification only; severity is raised by a harm the
// verifier confirmed, never by the number of lenses (lib/harm-verify.mjs, realm @nick/craft, node #407).
import { isToolSource } from './prior-decision-match.mjs'
import { claimsOf, groupClaims } from './harm-verify.mjs'

/** @typedef {import('./harm-verify.mjs').HarmClaim} HarmClaim */

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
 * The harm fields a merged group carries beside the base copy's own claim, which it keeps: every
 * distinct harm its lenses claimed (`harmClaims`, worst first, each with its own cited rule) for the
 * verifier to judge. The worst claim is only offered for verification — the cap never reads it
 * unverified (realm @nick/craft, node #407). A tool base carries no lens's claim.
 * @param {Record<string, unknown>} base
 * @param {Array<Record<string, unknown>>} members
 * @returns {{ harmClaims?: HarmClaim[] }}
 */
export function mergedHarmClaims(base, members) {
  if (isToolSource(base['source'])) return {}
  const claims = groupClaims(members.filter(m => !isToolSource(m['source'])))
  return claims.length > 1 ? { harmClaims: claims } : {}
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
