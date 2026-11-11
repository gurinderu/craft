// A pi task's answer, read from what `pi -p` printed (lib/pi-review-task.mjs): the task's agent has no write tool, so
// it prints its answer as one JSON object in a fence of its own, ```craft-answer, and the driver writes it to the task's
// answer file. The last `craft-answer` block holding an object is the answer — an example the agent prints after it in
// a `json` fence is not; without one, the last `json` block; without that, the last top-level `{…}` that parses as an
// object. A fence opens and closes at the start of a line, so ``` inside a JSON string closes nothing. Nothing more is
// checked here: the binary validates the answer against its schema and hands a bad one back for a retry.

/** The text as a JSON object, null when it is not one. @param {string} text @returns {Record<string, unknown> | null} */
function objectOf(text) {
  try {
    const v = JSON.parse(text)
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

/**
 * The object in the last block fenced as `lang` that holds one, null when none does; its fences at the start of a line.
 * @param {string} out @param {string} lang @returns {Record<string, unknown> | null}
 */
function lastFenced(out, lang) {
  const blocks = [...out.matchAll(new RegExp(`^\`\`\`${lang}[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n\`\`\`[ \\t]*$`, 'gm'))]
  for (let i = blocks.length - 1; i >= 0; i--) {
    const got = objectOf(String(blocks[i]?.[1]).trim())
    if (got) return got
  }
  return null
}

/**
 * Where the balanced `{…}` that opens at `start` closes, strings skipped; -1 when it never closes.
 * @param {string} out @param {number} start @returns {number}
 */
function closeOf(out, start) {
  let depth = 0
  let quoted = false
  for (let i = start; i < out.length; i++) {
    const c = out[i]
    if (quoted) {
      if (c === '\\') i++
      else if (c === '"') quoted = false
    } else if (c === '"') quoted = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return i
  }
  return -1
}

/** Each top-level balanced `{…}` in `out`, in order. @param {string} out @returns {string[]} */
function topLevelObjects(out) {
  /** @type {string[]} */
  const spans = []
  for (let i = out.indexOf('{'); i !== -1; i = out.indexOf('{', i + 1)) {
    const end = closeOf(out, i)
    // An unclosed brace in prose (`fn run() {`) hides nothing after it: the scan goes on from the next one.
    if (end === -1) continue
    spans.push(out.slice(i, end + 1))
    i = end
  }
  return spans
}

/**
 * The answer in what pi printed: the last `craft-answer` block holding an object, else the last such `json` block, else
 * the last top-level object that parses; null when there is none.
 * @param {string} out @returns {Record<string, unknown> | null}
 */
export function answerOf(out) {
  const fenced = lastFenced(out, 'craft-answer') ?? lastFenced(out, 'json')
  if (fenced) return fenced
  const spans = topLevelObjects(out)
  for (let i = spans.length - 1; i >= 0; i--) {
    const got = objectOf(String(spans[i]))
    if (got) return got
  }
  return null
}
