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
// A word about comments or fixing, which counts as working findings when a PR or review word stands anywhere in
// the same message: colloquial asks put them apart ("посмотри пр на предмет новых комментов"; #287).
const WORK = [
  /\bcomments?\b/i,
  /\b(?:fix|address|resolve)(?:es|ed|ing)?\b/i,
  new RegExp(`${RU}коммент\\p{L}*`, 'iu'),
  new RegExp(`${RU}(?:по|за)?фикс(?!ир|ац)\\p{L}*`, 'iu'),
  new RegExp(`${RU}(?:по|ис)прав\\p{L}*`, 'iu'),
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

/**
 * The class of a human prompt: `findings` (working findings or PR comments, or a comment or fix word beside a
 * PR or review word), `review` (asking for a review or naming a PR), or null.
 * @param {string} prompt @returns {'findings' | 'review' | null}
 */
export function promptKind(prompt) {
  if (NOT_A_REQUEST.test(prompt)) return null
  if (FINDINGS.some(re => re.test(prompt))) return 'findings'
  if (!REVIEW.some(re => re.test(prompt))) return null
  return WORK.some(re => re.test(prompt)) ? 'findings' : 'review'
}
