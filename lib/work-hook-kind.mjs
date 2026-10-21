// Which human prompts craft's work hook answers (lib/work-hook.mjs; realm @nick/craft, node #288): the findings
// class, the review class, a prompt in another script for the model to class itself, or none. The words matched are
// English or script-neutral (PR and MR, their URLs): a request in another language is not guessed at here.
import { continuation, notHuman, otherLanguage } from './work-hook-word.mjs'

/** @typedef {'findings' | 'review' | 'other-language'} PromptKind */

// Working findings or PR comments. A bare "fix" or "comments" is ordinary coding talk, so it counts only beside
// review words.
const FINDINGS = [
  /\bfindings?\b/i,
  /\b(?:review|PR|MR|pull[- ]request|merge[- ]request|reviewer'?s?)\s+(?:comments?|feedback|threads?|notes?|remarks?)\b/i,
  /\bcomments?\s+(?:on|in|from)\s+(?:the\s+|this\s+|that\s+|my\s+|our\s+|your\s+)?(?:PR|MR|pull[- ]request|merge[- ]request|review(?:er)?)\b/i,
  /\b(?:fix|address|resolve|apply)(?:es|ed|ing)?\s+(?:the\s+|all\s+|these\s+|those\s+)?(?:review|PR|MR)\b/i,
  // Feedback as the thing to work, not a noun modifier of a thing being built ("the feedback form").
  /\b(?:fix|address|resolve|apply|handle)(?:es|ed|ing)?\s+(?:the\s+|all\s+|this\s+|that\s+|their\s+|your\s+|our\s+)?feedback(?=\s*(?:$|[^\s\p{L}])|\s+(?:on|from|in|and|then|by|left|please)\b)/iu,
]
// Asking for a review or naming a PR or MR, by word or by its URL. "reviewed" is a report about the past and
// "preview" another word; a lowercase "pr" stands in paths and commands ("lib/pr.mjs", "gh pr view").
const REVIEW = [
  /\breview(?:s|ing)?\b/i,
  /\b(?:PR|MR)s?\b/,
  /\b(?:pull|merge)[- ]requests?\b/i,
]
// Read on the prompt as written: the words above are read with paths and file names taken out (PATHLIKE).
const LINKS = [/\bgithub\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/i, /\/merge_requests\/\d+/i]
// A path or a file name ("lib/pr/x.mjs", "review.js") names a file, not a review or a PR.
const PATHLIKE = /(?:[\w.-]+\/)+[\w.-]*|[\w-]+\.[a-z][a-z0-9]{0,5}\b/g

// A request that puts the comment or fix word apart from the PR or review it is about ("check the PR for new
// comments"; #287). A comment word counts beside such a target anywhere in the message, a fix word (commoner in
// plain coding) only within NEAR words of it and in the same clause ("after the PR merges, fix the CI config" fixes
// no PR); neither counts when that PR or review is the one the request makes
// ("fix the bug and open a PR"): there the fix or the comment is the work, not feedback on it.
const NEAR = 5
const COMMENT = /^comments?$/i
const FIX = /^(?:fix|address|resolve)(?:es|ed|ing)?$/i
const TARGET = [/^(?:PR|MR)s?$/, /^(?:review(?:s|ing)?|pullrequests?|mergerequests?)$/i]
// A verb that makes the PR or review the request is for: "the open PR" names one that exists. Between the verb and
// its object only FILLER; a verb after a determiner is an adjective.
const MAKE = /^(?:open|create|push|raise|submit|make|file|send|request|put)$/i
const FILLER = /^(?:a|an|the|new|draft|up|for|another)$/i
const DETERMINER = /^(?:the|a|an|this|that|these|those|my|our|your|their|its|any|all|other|on|in)$/i

const CLAUSE = /[,;!?]|\.(?=\s|$)/

/** The positions of the PRs and reviews in a clause's words that it does not make. @param {string[]} words */
function targetsIn(words) {
  /** @param {number} i @returns {boolean} */
  const made = i => {
    let j = i - 1
    while (j >= 0 && FILLER.test(words[j] ?? '')) j--
    return j >= 0 && MAKE.test(words[j] ?? '') && !DETERMINER.test(words[j - 1] ?? '')
  }
  return words.flatMap((w, i) => (TARGET.some(re => re.test(w)) && !made(i) ? [i] : []))
}

/** A comment or fix word about a PR or review the request does not make. @param {string} text @returns {boolean} */
function workOnFeedback(text) {
  const clauses = text.replace(/(pull|merge)[- ]request/giu, '$1request').split(CLAUSE)
    .map(c => c.match(/[\p{L}\p{N}']+/gu) ?? [])
  const targets = clauses.map(targetsIn)
  if (targets.every(t => t.length === 0)) return false
  return clauses.some((words, c) => words.some((w, i) =>
    COMMENT.test(w) || (FIX.test(w) && (targets[c] ?? []).some(t => Math.abs(t - i) <= NEAR))))
}

/**
 * The class of a human prompt: `other-language` when its words are mostly in another script than Latin (the
 * hook then lets the model class it); else `findings` (working findings or PR comments, or a comment or fix word
 * about a PR or review the request does not make), `review` (asking for a review or naming a PR or MR), or null;
 * a bare English continuation ("keep going") takes `recent`, the kind of the request it continues. An agent's
 * words the harness delivers as a prompt are no class.
 * @param {string} prompt @param {PromptKind | null} [recent] @returns {PromptKind | null}
 */
export function promptKind(prompt, recent = null) {
  if (notHuman(prompt)) return null
  if (otherLanguage(prompt)) return 'other-language'
  const text = prompt.replace(PATHLIKE, ' ')
  if (FINDINGS.some(re => re.test(text)) || workOnFeedback(text)) return 'findings'
  if (REVIEW.some(re => re.test(text)) || LINKS.some(re => re.test(prompt))) return 'review'
  return continuation(prompt) ? recent : null
}
