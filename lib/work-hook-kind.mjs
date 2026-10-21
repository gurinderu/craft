// Which human prompts craft's work hook answers (lib/work-hook.mjs; realm @nick/craft, node #288): the findings
// class, the review class, or none.

// The harness hands a background agent's result back as a prompt; its words are the agent's, not a request.
const NOT_A_REQUEST = /^\s*<task-notification>/
// JS's \b is ASCII-only, so a Cyrillic word edge is "no letter beside it".
const RU = '(?<!\\p{L})'
// Working findings or PR comments. A bare "fix" or "comments" is ordinary coding talk, so it counts only beside
// review words; "фикс" without that context also stands in "зафиксируй" (record) and "фиксация" (fixation).
const FINDINGS = [
  /\bfindings?\b/i,
  /\b(?:review|PR|pull[- ]request|reviewer'?s?)\s+(?:comments?|feedback|threads?|notes?|remarks?)\b/i,
  /\bcomments?\s+(?:on|in|from)\s+(?:the\s+|this\s+|that\s+|my\s+|our\s+|your\s+)?(?:PR|pull[- ]request|review(?:er)?)\b/i,
  /\b(?:fix|address|resolve|apply)(?:es|ed|ing)?\s+(?:the\s+|all\s+|these\s+|those\s+)?(?:review|PR)\b/i,
  // Feedback as the thing to work, not a noun modifier of a thing being built ("the feedback form").
  /\b(?:fix|address|resolve|apply|handle)(?:es|ed|ing)?\s+(?:the\s+|all\s+|this\s+|that\s+|their\s+|your\s+|our\s+)?feedback(?=\s*(?:$|[^\s\p{L}])|\s+(?:on|from|in|and|then|by|left|please)\b)/iu,
  new RegExp(`${RU}(?:находк|замечани)\\p{L}*`, 'iu'),
  new RegExp(`${RU}(?:комментари|фидб[еэ]к)\\p{L}*\\s+(?:к|в|на|по|из)\\s+(?:PR|MR|пр|пул+[- ]?реквест\\p{L}*|ревью)(?!\\p{L})`, 'iu'),
  new RegExp(`${RU}(?:(?:по|за)?фикс(?!ир|ац)|(?:по|ис)прав)\\p{L}*\\s+(?:по|к|в|на|из)\\s+(?:PR|MR|пр|ревью|коммент\\p{L}*|замечани\\p{L}*)(?!\\p{L})`, 'iu'),
]
// Asking for a review or naming a PR. "reviewed" is a report about the past and "preview" another word.
const REVIEW = [
  /\breview(?:s|ing)?\b/i,
  /\bPRs?\b/,
  /\bpull[- ]requests?\b/i,
  new RegExp(`${RU}ревью\\p{L}*`, 'iu'),
  new RegExp(`${RU}пул+[- ]?реквест\\p{L}*`, 'iu'),
  // The bare colloquial "пр" and its plurals; "и пр." (et cetera) ends in a dot.
  new RegExp(`${RU}пр(?:ы|ов|ам|ах|ами)?(?![\\p{L}.])`, 'iu'),
]

// Colloquial asks put the comment or fix word apart from the PR or review it is about ("посмотри пр на предмет
// новых комментов", "там есть ревью и что нужно пофиксить"; #287). A comment word counts beside such a target
// anywhere in the message, a fix word (commoner in plain coding) only within NEAR words of it; neither counts
// when that PR or review is the one the request makes ("fix the bug and open a PR"): there the fix or the comment
// is the work, not feedback on it.
const NEAR = 5
const COMMENT = /^(?:comments?|коммент\p{L}*)$/iu
const FIX = [/^(?:fix|address|resolve)(?:es|ed|ing)?$/i, /^(?:по|за)?фикс(?!ир|ац)\p{L}*$/iu, /^(?:по|ис)прав\p{L}*$/iu]
// Tested on the word without a trailing dot, but for the bare "пр": "и пр." (et cetera) ends in one.
const TARGET = [/^PRs?$/, /^(?:review(?:s|ing)?|pullrequests?)$/i, /^(?:ревью|пулреквест)\p{L}*$/iu]
const BARE_PR = /^пр(?:ы|ов|ам|ах|ами)?$/iu
// A verb that makes the PR or review the request is for, by whole form: "the open PR" and "открытый пр" name one
// that exists. Between the verb and its object only FILLER; an English verb after a determiner is an adjective.
const MAKE = /^(?:open|create|push|raise|submit|make|file|send|request|put|открой|открыть|создай|создать|сделай|сделать|запушь|запушить|пушни|заведи|завести|подними|поднять|отправь|отправить|запроси|запросить|оформи|оформить)$/iu
const FILLER = /^(?:a|an|the|new|draft|up|for|another|нов\p{L}*|ещ[её]|свой|свою|черновой)$/iu
const DETERMINER = /^(?:the|a|an|this|that|these|those|my|our|your|their|its|any|all|other|on|in)$/i

/** A comment or fix word about a PR or review the request does not make. @param {string} prompt @returns {boolean} */
function workOnFeedback(prompt) {
  const joined = prompt.replace(/pull[- ]request/giu, 'pullrequest').replace(/пул+[- ]?реквест/giu, 'пулреквест')
  const raw = joined.match(/[\p{L}\p{N}']+\.?/gu) ?? []
  const words = raw.map(w => w.replace(/\.$/, ''))
  /** @param {number} i @returns {boolean} */
  const made = i => {
    let j = i - 1
    while (j >= 0 && FILLER.test(words[j] ?? '')) j--
    return j >= 0 && MAKE.test(words[j] ?? '') && !DETERMINER.test(words[j - 1] ?? '')
  }
  const targets = words.flatMap((w, i) =>
    (TARGET.some(re => re.test(w)) || BARE_PR.test(raw[i] ?? '')) && !made(i) ? [i] : [])
  if (targets.length === 0) return false
  return words.some((w, i) => COMMENT.test(w) || (FIX.some(re => re.test(w)) && targets.some(t => Math.abs(t - i) <= NEAR)))
}

/**
 * The class of a human prompt: `findings` (working findings or PR comments, or a comment or fix word about a PR or
 * review the request does not make), `review` (asking for a review or naming a PR), or null.
 * @param {string} prompt @returns {'findings' | 'review' | null}
 */
export function promptKind(prompt) {
  if (NOT_A_REQUEST.test(prompt)) return null
  if (FINDINGS.some(re => re.test(prompt)) || workOnFeedback(prompt)) return 'findings'
  return REVIEW.some(re => re.test(prompt)) ? 'review' : null
}
