// What a record's scope check compares against: its commit, else the merge on the trunk of the pull request
// of this repository it links (realm @nick/craft, node #682), else the UTC day its `when` names — a record
// written where no commit may be named still sets a finding aside when the code in its scope is unchanged
// since the trunk's last commit before that day began (realm @nick/craft, node #676).
// Imported by integrations/shared/prior-decision-scope.mjs and integrations/shared/prior-decision-apply.mjs.

import { isoMoment } from './memory-recall.mjs'

/** @typedef {import('./prior-decisions.mjs').PriorDecision} PriorDecision */

/**
 * The UTC day of the ISO date a record's `when` is (a timestamp's zone applied, isoMoment), or of the
 * `YYYY-MM-DD` it starts with when words follow it; '' when neither names a real day.
 * @param {PriorDecision} d @returns {string}
 */
export function decisionDate(d) {
  const whole = isoMoment(d.when)
  if (whole) return whole.day
  const lead = /^(\d{4}-\d{2}-\d{2})(?![\dT])/.exec(d.when)?.[1]
  return (lead && isoMoment(lead)?.day) || ''
}

/** Whether a record names something its scope can be compared against: a commit, a pull request or a date. @param {PriorDecision} d */
export function hasAnchor(d) {
  return !!d.commit || !!d.pulls?.length || !!decisionDate(d)
}

/**
 * What a record's scope is said to have changed since: the merge of pull request `pr` when its scope was
 * compared against that (realm @nick/craft, node #682), else its commit, or its date.
 * @param {PriorDecision} d @param {number} [pr] @returns {string}
 */
export function anchorSince(d, pr) {
  if (pr) return `the merge of PR #${pr}`
  const day = decisionDate(d)
  return d.commit || (day ? `the decision date ${day}` : 'a merge on the trunk')
}

// Why a record anchored by its pull requests alone names nothing to compare against.
const UNMERGED = 'no pull request of this repository it links is merged on the trunk, and it records no date — raised normally'

/**
 * Why a record did not apply when its anchor names no commit to compare against (realm @nick/craft, node
 * #184), by the word its scope-check line printed: `missing` (the commit, or a trunk commit before the
 * date, absent), `future`, `no-trunk`, `unreadable`, `unmerged` (no merge of a pull request it links, and
 * no date to fall back on).
 * @param {PriorDecision} d @param {string} [said] @returns {string}
 */
export function anchorMissingReason(d, said = 'missing') {
  if (d.commit) return `commit ${d.commit} not found in this repo — raised normally`
  const day = decisionDate(d)
  if (!day || said === 'unmerged') return UNMERGED
  if (said === 'future') return `the decision date ${day} is in the future, so no commit precedes it — raised normally`
  if (said === 'no-trunk')
    return `no trunk could be resolved (no origin/HEAD, origin/main or origin/master), so nothing anchors the decision date ${day} — raised normally`
  if (said === 'unreadable') return `git could not list the trunk's commits before the decision date ${day} — raised normally`
  return `no commit in this repo before the decision date ${day} — raised normally`
}
