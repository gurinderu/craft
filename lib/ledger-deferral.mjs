// The deferral a `deferred` review-ledger row carries: the question that set its finding aside (realm
// @nick/craft, node #204). Its own module, with no imports, so the run logger (lib/craft-log-run.mjs),
// which normalises every ledger row it loads, reads it without taking the prior-decision modules into
// its closure. Inlined into src/review.js and src/adversarial-review.js before
// lib/prior-decision-apply.mjs.

/**
 * A question's deferral as a structured field on the ledger row: its id, reason, author, date, link and
 * commit. A carried row is read by this field, never by the mark in its `why` — the between-round
 * transport cuts every `why` at its cap, and the mark sits at the tail.
 * @typedef {{ id: string, reason: string, who: string, when: string, link: string, commit: string }} Deferral
 */
/**
 * The deferral a question record (a PriorDecision of kind `question`) sets on the finding it sets aside.
 * @param {Deferral} d @returns {Deferral}
 */
export function deferralOf(d) {
  return { id: d.id, reason: d.reason, who: d.who, when: d.when, link: d.link, commit: d.commit }
}

/**
 * The deferral a ledger row carries, every part a string; null when it carries none (a row marked
 * `deferred` with no question record behind it).
 * @param {unknown} v @returns {Deferral | null}
 */
export function deferralOn(v) {
  if (!v || typeof v !== 'object') return null
  const o = /** @type {Record<string, unknown>} */ (v)
  /** @param {string} k */
  const s = k => (typeof o[k] === 'string' ? /** @type {string} */ (o[k]) : '')
  return s('id') ? { id: s('id'), reason: s('reason'), who: s('who'), when: s('when'), link: s('link'), commit: s('commit') } : null
}
