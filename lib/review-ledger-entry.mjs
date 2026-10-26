// The ledger entry the review engine (src/review.js) persists for a finding, so round N+1 can find round N.
import { TRACKED_MARK } from './review-adjudicate.mjs'
import { THINNED_CLAUSE } from './review-verify.mjs'
import { deferralOn } from './ledger-deferral.mjs'
import { fingerprint } from './run-record.mjs'

/** @typedef {import('./review-schemas.mjs').Finding} Finding */

// TRACKED_MARK IS STRIPPED HERE, AND ONLY HERE. "this site is already tracked by a still-live prior
// finding" is a statement about THIS round, computed from this round's live priors. `why` is a
// persisted ledger field, so appending it made the sentence travel into round N+1 verbatim — where
// it became false the moment that prior resolved or retired, and nothing re-evaluated it. Stripping
// at the ledger door keeps the mark in the report, where it is true, and out of the record, where
// nothing can keep it true. Re-evaluating it instead was rejected: the mark is recomputed from
// scratch every round anyway (markTrackedUnverified), so a carried copy can only ever be a stale
// duplicate of a fresh computation.
/** @param {Finding} f @param {string | undefined} disposition @param {string} [tier] */
export const toLedgerEntry = (f, disposition, tier) => ({
  ...ledgerLocation(f),
  severity: f['severity'], tier: tier || f['tier'] || 'suspected', disposition: disposition || f['disposition'] || 'open',
  source: f['source'] || '', ruleId: f['ruleId'] || '', title: f['title'] || '', why: String(f['why'] || '').split(TRACKED_MARK).join('').replace(THINNED_CLAUSE, ''),
  ...ledgerSources(f),
  ...ledgerToolRule(f),
  ...ledgerWhyRef(f),
  ...ledgerDeferral(f),
})

/** A ledger entry's `deferral`, present only on a finding a question set aside. @param {Finding} f */
export function ledgerDeferral(f) {
  const deferral = deferralOn(f['deferral'])
  return deferral ? { deferral } : {}
}

/** The leading fields of a ledger entry: its fingerprint and where it sits. @param {Finding} f */
export function ledgerLocation(f) {
  return { fp: f['fp'] || fingerprint(f), file: f['file'] || '', line: f['line'] || 0, symbol: f['symbol'] || '' }
}

/**
 * A ledger entry's `toolRule`, present only when the finding carries one: a gate tool's own rule rides
 * the ledger beside `source`, so a carried finding keeps it next round (realm @nick/craft, node #236).
 * @param {Finding} f
 */
export function ledgerToolRule(f) {
  return typeof f['toolRule'] === 'string' && f['toolRule'] ? { toolRule: f['toolRule'] } : {}
}

/** A ledger entry's `sources`, present only when the finding carries an array of them. @param {Finding} f */
export function ledgerSources(f) {
  return Array.isArray(f['sources']) ? { sources: /** @type {unknown[]} */ (f['sources']) } : {}
}

/** @param {Finding} f */
export function ledgerWhyRef(f) {
  // A CARRIED finding arrived from the prior-round transport with a SHORTENED `why` and a `whyRef`
  // pointing at the record its FULL `why` lives in (its birth). Persist that pointer so the short-why/
  // full-by-reference chain survives into the next round. A FRESH finding (born this round, straight
  // from a lens) has no `whyRef`: its full `why` is persisted here verbatim and NO pointer is written.
  return f['whyRef'] && typeof f['whyRef'].record === 'string' && typeof f['whyRef'].fp === 'string'
    ? { whyRef: { record: f['whyRef'].record, fp: f['whyRef'].fp } } : {}
}
