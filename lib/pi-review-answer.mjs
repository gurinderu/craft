// A pi task's answer, read from what `pi -p` printed (lib/pi-review-task.mjs): the task's agent has no write tool, so
// it prints its answer as one JSON object at the end and the driver writes it to the task's answer file. The last
// fenced `json` block is the answer; without one, the last top-level `{…}` that parses as an object. Nothing more is
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

/** The body of the last fenced `json` block, null when there is none. @param {string} out @returns {string | null} */
function lastFence(out) {
  const blocks = [...out.matchAll(/```json[ \t]*\r?\n([\s\S]*?)\r?\n?```/g)]
  return blocks.length ? String(blocks[blocks.length - 1]?.[1]) : null
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
    if (end === -1) break
    spans.push(out.slice(i, end + 1))
    i = end
  }
  return spans
}

/**
 * The answer in what pi printed: the last fenced `json` block when it holds an object, else the last top-level object
 * that parses; null when there is none.
 * @param {string} out @returns {Record<string, unknown> | null}
 */
export function answerOf(out) {
  const fenced = lastFence(out)
  const inFence = fenced === null ? null : objectOf(fenced.trim())
  if (inFence) return inFence
  const spans = topLevelObjects(out)
  for (let i = spans.length - 1; i >= 0; i--) {
    const got = objectOf(String(spans[i]))
    if (got) return got
  }
  return null
}
