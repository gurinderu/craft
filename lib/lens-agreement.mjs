// Multi-lens agreement (realm @nick/craft, node #379): two or more different lenses that report the
// same defect independently — merged into one finding by the cross-lens dedup before verification
// (lib/review-dedup.mjs, its `sources`) — are evidence a single lens is not. Such a finding is verified
// whatever severity its copies were filed at, and once confirmed it is raised to High when the harm it
// names allows must-fix: every copy filing Low under a must-fix harm is the under-call that kept a
// headline mechanism that never works out of the verdict. The harm cap still runs after, so a raise
// never exceeds what the named harm allows.
import { isToolSource } from './prior-decision-match.mjs'
import { HARM_CEILING, HARM_LEVELS } from './harm-levels.mjs'
import { effectiveLevel } from './harm-cap.mjs'

/** How many different lenses make an agreement. */
export const LENS_AGREEMENT_MIN = 2

/** The words the raise's note carries in `why`. */
export const LENS_AGREEMENT_MARK = 'multi-lens agreement'

const BELOW_HIGH = ['Medium', 'Low', 'Info']

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
 * `f` raised to High when lenses agreed on it, a verifier confirmed it and its named harm allows
 * must-fix; otherwise `f` itself.
 * @template {{ severity?: string, tier?: string, why?: string, harmLevel?: string, harm?: string, source?: string, sources?: unknown, repoRule?: unknown }} F
 * @param {F} f
 * @returns {F}
 */
export function agreementRaise(f) {
  if (f.tier !== 'confirmed' || !BELOW_HIGH.includes(String(f.severity ?? ''))) return f
  const level = effectiveLevel(f)
  if (level === undefined || HARM_CEILING[level] !== 'Critical' || !lensAgreed(f)) return f
  return { ...f, severity: 'High', why: `${f.why ?? ''} (raised to High from ${f.severity}: ${LENS_AGREEMENT_MARK} — ${agreeingLenses(f).join(', ')} reported it independently, a verifier confirmed it, and its harm level ${level} is must-fix)` }
}

/** A level's rank, worst first; an absent or unknown level last. @param {string | undefined} level */
function harmRank(level) {
  const at = level === undefined ? -1 : HARM_LEVELS.indexOf(level)
  return at < 0 ? HARM_LEVELS.length : at
}

/**
 * The harm fields a merged group carries: those of the member naming the worst harm, as the cap reads
 * it, when that is worse than the base's; {} otherwise, and always for a tool base, which carries no
 * lens's claim. Five lenses on one defect, one of them naming the must-fix harm the others missed,
 * keep that harm for the verifier and the raise.
 * @param {{ source?: string, harmLevel?: string, harm?: string, repoRule?: unknown }} base
 * @param {Array<{ source?: string, harmLevel?: string, harm?: string, repoRule?: unknown }>} members
 * @returns {{ harmLevel?: string, harm?: string, repoRule?: unknown }}
 */
export function worstHarmOf(base, members) {
  if (isToolSource(base.source)) return {}
  const worst = members.filter(m => !isToolSource(m.source)).reduce((a, m) => (harmRank(effectiveLevel(m)) < harmRank(effectiveLevel(a)) ? m : a), base)
  if (worst === base) return {}
  /** @type {{ harmLevel?: string, harm?: string, repoRule?: unknown }} */
  const out = {}
  if (worst.harmLevel !== undefined) out.harmLevel = worst.harmLevel
  if (worst.harm !== undefined) out.harm = worst.harm
  if (worst.repoRule !== undefined) out.repoRule = worst.repoRule
  return out
}

/**
 * Records on `kept` that another lens filed the very same finding (same file, line and title), which
 * the pool's exact-key check otherwise drops without a trace: `kept.sources` gains the copy's source.
 * @param {{ source?: unknown, sources?: unknown } | undefined} kept  the pooled finding, mutated
 * @param {{ source?: unknown }} copy
 */
export function noteExactCopy(kept, copy) {
  if (!kept || typeof copy.source !== 'string' || copy.source === '' || copy.source === kept.source) return
  const had = Array.isArray(kept.sources) ? kept.sources : [kept.source]
  if (!had.includes(copy.source)) kept.sources = [...had, copy.source]
}
