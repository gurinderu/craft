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
  new RegExp(`${RU}(?:находк|замечани)\\p{L}*`, 'iu'),
  new RegExp(`${RU}комментари\\p{L}*\\s+(?:к|в|на|по|из)\\s+(?:PR|MR|пр|пул+[- ]?реквест\\p{L}*|ревью)(?!\\p{L})`, 'iu'),
  new RegExp(`${RU}(?:по|за)?фикс(?!ир|ац)\\p{L}*\\s+(?:по|к|в|на|из)\\s+(?:PR|MR|пр|ревью|комментари\\p{L}*|замечани\\p{L}*)(?!\\p{L})`, 'iu'),
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

// Colloquial asks put the comment or fix word a few words from the PR or review it is about ("посмотри пр на
// предмет новых комментов", "там есть ревью и что нужно пофиксить"; #287). So a work word is findings work only
// within NEAR words of such a target, and not when that PR or review is the one the request makes ("fix the bug and
// open a PR", "add doc comments and create a pr"): there the fix or the comment is the work, not feedback on it.
const NEAR = 5
const WORK = [
  /^comments?$/i,
  /^(?:fix|address|resolve)(?:es|ed|ing)?$/i,
  /^коммент\p{L}*$/iu,
  /^(?:по|за)?фикс(?!ир|ац)\p{L}*$/iu,
  /^(?:по|ис)прав\p{L}*$/iu,
]
const TARGET = [
  /^PRs?$/,
  /^(?:review(?:s|ing|ers?)?|pullrequests?|feedback)$/i,
  /^(?:ревью|пулреквест|фидб[еэ]к)\p{L}*$/iu,
  /^пр(?:ы|ов|ам|ах|ами)?$/iu,
]
// A verb that makes the PR or review the request is for, and the words that may stand between it and its object.
const MAKE = /^(?:open|create|push|raise|submit|make|file|send|request|put|откр|созд|сдела|запуш|пушн|завед|завест|подн|отправ|запрос|оформ)/iu
const FILLER = /^(?:a|an|the|new|draft|up|for|another|нов\p{L}*|ещ[её]|свой|свою|черновой)$/iu

/** A fix or comment word near a PR or review the request does not make. @param {string} prompt @returns {boolean} */
function workOnFeedback(prompt) {
  const joined = prompt.replace(/pull[- ]request/giu, 'pullrequest').replace(/пул+[- ]?реквест/giu, 'пулреквест')
  const words = joined.match(/[\p{L}\p{N}']+/gu) ?? []
  /** @param {number} i @returns {boolean} */
  const made = i => {
    let j = i - 1
    while (j >= 0 && FILLER.test(words[j] ?? '')) j--
    return j >= 0 && MAKE.test(words[j] ?? '')
  }
  const targets = words.flatMap((w, i) => TARGET.some(re => re.test(w)) && !made(i) ? [i] : [])
  return words.some((w, i) => WORK.some(re => re.test(w)) && targets.some(t => Math.abs(t - i) <= NEAR))
}

/**
 * The class of a human prompt: `findings` (working findings or PR comments, or a fix or comment word a few words
 * from a PR or review the request does not make), `review` (asking for a review or naming a PR), or null.
 * @param {string} prompt @returns {'findings' | 'review' | null}
 */
export function promptKind(prompt) {
  if (NOT_A_REQUEST.test(prompt)) return null
  if (FINDINGS.some(re => re.test(prompt)) || workOnFeedback(prompt)) return 'findings'
  return REVIEW.some(re => re.test(prompt)) ? 'review' : null
}
