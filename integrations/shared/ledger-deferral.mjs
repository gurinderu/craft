// The deferral a `deferred` review-ledger row carries: the question that set its finding aside (realm
// @nick/craft, node #204). Its own module, with no imports, so the run logger (integrations/shared/craft-log-run.mjs),
// which normalises every ledger row it loads, reads it without taking the prior-decision modules into
// its closure. Imported by integrations/claude-code/src/triage-findings.js.

/**
 * A question's deferral as a structured field on the ledger row: its id, reason, author, date, link and
 * commit, the pull requests its links name when it links any — the next round anchors it by them
 * where it names no commit —, and the question's own scope, which the next round checks unchanged as
 * the memory checks the question, wider than the row's file when it names a folder (realm @nick/craft,
 * node #680). A carried row is read by this field, never by the mark in its `why` — the between-round
 * transport cuts every `why` at its cap, and the mark sits at the tail.
 * @typedef {{ repo: string, number: number }} DeferralPull
 * @typedef {{ id: string, reason: string, who: string, when: string, link: string, commit: string, pulls?: DeferralPull[], scope?: string }} Deferral
 */
/**
 * The deferral a question record (a PriorDecision of kind `question`) sets on the finding it sets aside.
 * @param {Deferral} d @returns {Deferral}
 */
export function deferralOf(d) {
  const pulls = d.pulls?.length ? { pulls: d.pulls.map(p => ({ repo: p.repo, number: p.number })) } : {}
  const scope = d.scope ? { scope: d.scope } : {}
  return { id: d.id, reason: d.reason, who: d.who, when: d.when, link: d.link, commit: d.commit, ...pulls, ...scope }
}

/**
 * The pull requests a ledger row's deferral names, each a repository and a positive number; the
 * others dropped.
 * @param {unknown} v @returns {DeferralPull[]}
 */
function pullsOn(v) {
  if (!Array.isArray(v)) return []
  return /** @type {unknown[]} */ (v).flatMap(p => {
    if (!p || typeof p !== 'object') return []
    const { repo, number } = /** @type {Record<string, unknown>} */ (p)
    return typeof repo === 'string' && Number.isSafeInteger(number) && Number(number) > 0 ? [{ repo, number: Number(number) }] : []
  })
}

/**
 * The deferral a ledger row carries: its text parts strings ('' when not one), its pull requests
 * (`pullsOn`) and its scope kept only when present and well-formed; null when it carries none (a row
 * marked `deferred` with no question record behind it).
 * @param {unknown} v @returns {Deferral | null}
 */
export function deferralOn(v) {
  if (!v || typeof v !== 'object') return null
  const o = /** @type {Record<string, unknown>} */ (v)
  /** @param {string} k */
  const s = k => (typeof o[k] === 'string' ? /** @type {string} */ (o[k]) : '')
  if (!s('id')) return null
  const pulls = pullsOn(o['pulls'])
  return {
    id: s('id'),
    reason: s('reason'),
    who: s('who'),
    when: s('when'),
    link: s('link'),
    commit: s('commit'),
    ...(pulls.length ? { pulls } : {}),
    ...(s('scope') ? { scope: s('scope') } : {}),
  }
}
