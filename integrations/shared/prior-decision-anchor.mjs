// What a record's scope check compares against: its commit, else the calendar date its `when` starts
// with — a record written where no commit may be named still sets a finding aside when the code in its
// scope is unchanged since the last commit before 00:00 UTC of that day (realm @nick/craft, node #676).
// Imported by integrations/shared/prior-decision-scope.mjs and integrations/shared/prior-decision-apply.mjs.

import { monthDays } from './memory-recall.mjs'

/** @typedef {import('./prior-decisions.mjs').PriorDecision} PriorDecision */

/**
 * The `YYYY-MM-DD` date a record's `when` starts with, a real day of the calendar not run on by another
 * digit; '' otherwise. @param {PriorDecision} d @returns {string}
 */
export function decisionDate(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(d.when)
  if (!m) return ''
  const [day, y, mo, dd] = [m[0], Number(m[1]), Number(m[2]), Number(m[3])]
  return mo >= 1 && mo <= 12 && dd >= 1 && dd <= monthDays(y, mo) ? day : ''
}

/** Whether a record names something its scope can be compared against: a commit or a date. @param {PriorDecision} d */
export function hasAnchor(d) {
  return !!d.commit || !!decisionDate(d)
}

/** What a record's scope is said to have changed since: its commit, or its date. @param {PriorDecision} d @returns {string} */
export function anchorSince(d) {
  return d.commit || `the decision date ${decisionDate(d)}`
}

/** Why a record did not apply when the repo holds no commit for its anchor (realm @nick/craft, node #184). @param {PriorDecision} d */
export function anchorMissingReason(d) {
  if (d.commit) return `commit ${d.commit} not found in this repo — raised normally`
  return `no commit in this repo before the decision date ${decisionDate(d)} — raised normally`
}
