// How an engine reads the options it was launched with.
//
// The Workflow tool hands `args` through verbatim, and a caller has three plausible ways to spell
// them — a real object, a JSON string, and the `key=value` form the skill's own invocation line
// advertises. Only the first worked. The other two fell through every `typeof args === 'object'`
// guard, so every option reverted to its default and the run reviewed whatever the session happened
// to be sitting in, then reported a confident verdict for a diff nobody asked about. Measured: a
// review launched with `base=v0.17.0` reviewed one uncommitted file on the working tree instead of
// the 23-commit range, and nothing in the report said so.
//
// Silence is the whole defect, so this never fails silently: an unparseable value says what arrived
// and that the options were dropped.

// One match of parseOptions' pattern, applied: a `--flag` or `key=value` stored into `out`, a refused
// name pushed onto `ignored`; 1 when it stored a pair, 0 when it refused one. Exported because a
// module-level helper is copied into the engines' inlined regions only when it is, and the fence's
// sibling check only knows about EXPORTS — a private helper reaches every engine as a ReferenceError
// on first use, with the gate green.
/**
 * @param {RegExpExecArray} m
 * @param {Record<string, unknown>} out
 * @param {string[]} ignored
 * @returns {number}
 */
export function applyOption(m, out, ignored) {
  /** @param {string} k */
  const banned = k => k === '__proto__' || k === 'constructor' || k === 'prototype'
  if (m[7]) {
    if (banned(m[7])) { ignored.push(m[7]); return 0 }
    out[m[7]] = true
    return 1
  }
  const key = /** @type {string} */ (m[2])
  // `__proto__` is a live setter on a plain object: `__proto__={"craftRoot":"/evil"}` stores no own
  // key and yet makes `A.craftRoot` read `/evil`, which is interpolated into the shell instructions
  // the logger agent is handed. The args string is model-composed, so this is the same threat shape
  // as a model-supplied path, reached by a quieter door. A null-prototype object does not fix it on
  // its own — `Object.assign` back to a plain object re-triggers the setter — and these are never
  // legitimate option names, so they are refused by name and reported.
  if (banned(key)) { ignored.push(key); return 0 }
  const quoted = m[4] ?? m[5]
  if (quoted !== undefined) { out[key] = quoted; return 1 }
  try {
    out[key] = JSON.parse(/** @type {string} */ (m[3]))
  } catch {
    out[key] = /** @type {string} */ (m[3])
  }
  return 1
}

// Only `key=value` counts as an option, and that is a deliberate narrowing rather than a limitation.
// A bare word cannot become a flag: once any pair is present, the rest of an unquoted sentence would
// otherwise turn into options nobody wrote — `base=v1 intent=review the auth refactor strict` would
// invent `strict`, and an invented `strict` changes what the run does. A flag is written `strict=true`
// or `--strict`; a leading dash is an unambiguous statement of intent, a bare word is not.
/**
 * @param {string} text
 * @returns {{ options: Record<string, unknown>, pairs: number, ignored: string[] }}
 */
export function parseOptions(text) {
  const pair = /(--?)?(\w[\w-]*)=("([^"]*)"|'([^']*)'|\S+)|(--)(\w[\w-]*)/g
  /** @type {Record<string, unknown>} */
  const out = {}
  let pairs = 0
  /** @type {string[]} */
  const ignored = []
  let m
  let cursor = 0
  while ((m = pair.exec(text)) !== null) {
    // Anything skipped over between matches is prose, not an option: collect it so the caller can say
    // what it ignored instead of silently swallowing half the input.
    const gap = text.slice(cursor, m.index).trim()
    if (gap) ignored.push(...gap.split(/\s+/))
    cursor = pair.lastIndex
    pairs += applyOption(m, out, ignored)
  }
  const tail = text.slice(cursor).trim()
  if (tail) ignored.push(...tail.split(/\s+/))
  return { options: out, pairs, ignored }
}


/**
 * Normalize whatever arrived into an options object.
 *
 * `warn` is called with one human sentence per degradation and must not throw — engines pass their
 * `log`. It is called on the recovered forms too, deliberately: a run that silently accepted a
 * shape it had to repair teaches the next caller nothing.
 *
 * @param {unknown} args
 * @param {(msg: string) => void} [warn]
 * @returns {Record<string, unknown>}
 */
export function normalizeArgs(args, warn = () => {}) {
  if (args && typeof args === 'object' && !Array.isArray(args)) return /** @type {Record<string, unknown>} */ (args)
  if (typeof args !== 'string' || !args.trim()) return {}
  const text = args.trim()
  // A JSON scalar or array is not an options object, and must not be mistaken for the key=value form
  // below: `[1,2,3]` and `"a sentence"` would otherwise become flags named after their own contents.
  if (text.startsWith('[') || text.startsWith('"')) {
    warn(`⚠️ args arrived as a JSON value that is not an object (${text.slice(0, 40)}) — ALL options ignored, running with defaults`)
    return {}
  }
  if (text.startsWith('{')) return normalizeJsonArgs(text, warn)
  return normalizeKeyValueArgs(text, warn)
}

// normalizeArgs' branch for a string that starts with `{`.
/**
 * @param {string} text
 * @param {(msg: string) => void} warn
 * @returns {Record<string, unknown>}
 */
export function normalizeJsonArgs(text, warn) {
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      warn('⚠️ args arrived as a JSON string, not an object — parsed it; pass a real object to avoid this')
      return parsed
    }
    warn('⚠️ args arrived as a non-object JSON value — ALL options ignored, running with defaults')
    return {}
  } catch (e) {
    warn(`⚠️ args arrived as a string that looks like JSON but is not (${String((e && /** @type {{ message?: unknown }} */ (e).message) || e).slice(0, 60)}) — ALL options ignored, running with defaults`)
    return {}
  }
}

// normalizeArgs' last branch: a non-empty string that is not JSON, read as `key=value` options.
/**
 * @param {string} text
 * @param {(msg: string) => void} warn
 * @returns {Record<string, unknown>}
 */
export function normalizeKeyValueArgs(text, warn) {
  const { options, pairs, ignored } = parseOptions(text)
  if (pairs) {
    // Counted, not inferred from the values: `mutants=true` is a pair whose value is boolean true,
    // and testing "is any value not true" threw away every string made only of boolean options —
    // `mutants=true` became {} with a warning saying the input was not understood, which is how a
    // requested mutation pass would silently not run.
    warn('⚠️ args arrived as a key=value string — parsed it; pass a real object to avoid this')
    if (ignored.length) {
      warn(`⚠️ ignored ${ignored.length} word(s) in args that are not options (${ignored.slice(0, 6).join(' ')}) — quote a value that contains spaces`)
    }
    return options
  }
  // Reaching here means a non-empty string that is neither JSON nor a single recognizable pair. The
  // loud path matters more than it looks: this is the branch a typo lands in, and defaults produce a
  // verdict that reads exactly like a requested one.
  warn(`⚠️ args arrived as an unrecognized string (${text.slice(0, 40)}) — ALL options ignored, running with defaults`)
  return {}
}
