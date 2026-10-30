// Severity is raised by a verified harm, not by the number of lenses (realm @nick/craft, node #407).
// The verifier is shown the harm a finding claims — or, for a merged finding, the distinct harms its
// lenses claimed, worst first — and says whether the code shows it (`harmSupported`) and which claim
// held (`confirmedHarmLevel`). A panel majority sets `harmVerified` on a finding it confirmed and did
// not demote; `harmRaise` then lifts such a finding to High when that harm is must-fix. A finding the
// reach demotion lowered carries no `harmVerified`: lowering for reachability wins over the raise.
import { HARM_CEILING, HARM_LEVELS } from './harm-levels.mjs'
import { effectiveLevel } from './harm-cap.mjs'
import { flattenField } from './prompt-fields.mjs'
import { sanitizeAttack } from './review-adjudicate.mjs'

/** @typedef {{ harmLevel: string, harm?: string }} HarmClaim */

/** The words the raise's note carries in `why`. */
export const HARM_RAISE_MARK = 'verified harm'

/** A level's rank, worst first; an absent or unknown level last. @param {unknown} level */
export function harmRank(level) {
  const at = typeof level === 'string' ? HARM_LEVELS.indexOf(level) : -1
  return at < 0 ? HARM_LEVELS.length : at
}

/**
 * The harms a finding claims, worst first, one per level: its `harmClaims` (a merged finding's) or
 * its own `harmLevel` and `harm`. Unknown levels are left out.
 * @param {Record<string, unknown>} f
 * @returns {HarmClaim[]}
 */
export function claimsOf(f) {
  const raw = Array.isArray(f['harmClaims']) ? f['harmClaims'] : [{ harmLevel: f['harmLevel'], harm: f['harm'] }]
  return unionClaims(raw)
}

/** @param {unknown[]} raw @returns {HarmClaim[]} */
function unionClaims(raw) {
  /** @type {Map<string, HarmClaim>} */
  const by = new Map()
  for (const c of raw) {
    const { harmLevel, harm } = /** @type {{ harmLevel?: unknown, harm?: unknown }} */ (c ?? {})
    if (typeof harmLevel !== 'string' || !HARM_LEVELS.includes(harmLevel) || by.has(harmLevel)) continue
    by.set(harmLevel, typeof harm === 'string' ? { harmLevel, harm } : { harmLevel })
  }
  return [...by.values()].sort((a, b) => harmRank(a.harmLevel) - harmRank(b.harmLevel))
}

/** The distinct harms a group of findings claims, worst first. @param {Array<Record<string, unknown>>} members */
export function groupClaims(members) {
  return unionClaims(members.flatMap(claimsOf))
}

/**
 * Whether any harm `f` claims is must-fix as the cap reads it (a `repo-rule` needs its rule cited).
 * @param {Record<string, unknown>} f
 */
export function mayBeMustFix(f) {
  return claimsOf(f).some(c => {
    const level = effectiveLevel({ ...f, harmLevel: c.harmLevel })
    return level !== undefined && HARM_CEILING[level] === 'Critical'
  })
}

/**
 * The verifier's lines on the claimed harm, '' when the finding claims none.
 * @param {Record<string, unknown>} f
 * @returns {string}
 */
export function harmVerifyLine(f) {
  const claims = claimsOf(f)
  if (!claims.length) return ''
  const list = claims.map(c => `${c.harmLevel}${c.harm ? `: ${sanitizeAttack(flattenField(c.harm))}` : ''}`).join(' | ')
  return `\n  harm claimed (worst first; effect, who, recovery): ${list}`
}

/** What the verifier is asked about the harm, the same for both prompts. */
export const HARM_QUESTION = 'harmSupported: does the code show the FIRST claimed harm — its effect, who is affected, and the recovery — as stated? If several are listed and a later one holds instead, set harmSupported=true and confirmedHarmLevel to the worst listed one that holds. false when no claim holds or none is listed; never name a level that is not listed.'

/**
 * The harm a panel confirmed: the worst claim a majority of the shaped votes support (a vote naming
 * a claim supports it and every lesser one), or undefined.
 * @param {Record<string, unknown>} f
 * @param {Array<{ harmSupported?: unknown, confirmedHarmLevel?: unknown }>} votes
 * @returns {string | undefined}
 */
export function panelHarm(f, votes) {
  const claims = claimsOf(f)
  if (!claims.length || !votes.length) return undefined
  const levels = claims.map(c => c.harmLevel)
  const backed = votes.map(v => {
    if (v.harmSupported !== true) return undefined
    const named = v.confirmedHarmLevel ?? levels[0]
    return typeof named === 'string' && levels.includes(named) ? named : undefined
  })
  // A strict majority: a split panel raises nothing.
  const need = Math.floor(votes.length / 2) + 1
  return levels.find(l => backed.filter(b => b !== undefined && harmRank(b) <= harmRank(l)).length >= need)
}

/**
 * `f` raised to High when a verifier panel confirmed it and the harm it verified is must-fix (as the
 * cap reads it); otherwise `f` itself.
 * @template {{ severity?: string, tier?: string, why?: string, harmLevel?: string, harm?: string, harmVerified?: unknown, repoRule?: unknown, [k: string]: unknown }} F
 * @param {F} f
 * @returns {F}
 */
export function harmRaise(f) {
  const level = f.harmVerified
  if (f.tier !== 'confirmed' || typeof level !== 'string' || !['Medium', 'Low', 'Info'].includes(String(f.severity ?? ''))) return f
  const effective = effectiveLevel({ ...f, harmLevel: level })
  if (effective === undefined || HARM_CEILING[effective] !== 'Critical') return f
  const claim = claimsOf(f).find(c => c.harmLevel === level)
  return { ...f, severity: 'High', harmLevel: level, ...(claim?.harm === undefined ? {} : { harm: claim.harm }), why: `${f.why ?? ''} (raised to High from ${f.severity}: ${HARM_RAISE_MARK} — a verifier confirmed the ${level} harm, which is must-fix)` }
}
