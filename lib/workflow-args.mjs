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

// Only `key=value` counts as an option, and that is a deliberate narrowing rather than a limitation.
// A bare word cannot become a flag: once any pair is present, the rest of an unquoted sentence would
// otherwise turn into options nobody wrote — `base=v1 intent=review the auth refactor strict` would
// invent `strict`, and an invented `strict` changes what the run does. A flag is written `strict=true`
// or `--strict`; a leading dash is an unambiguous statement of intent, a bare word is not.
export function parseOptions(text) {
  const pair = /(--?)?(\w[\w-]*)=("([^"]*)"|'([^']*)'|\S+)|(--)(\w[\w-]*)/g
  const out = {}
  let pairs = 0
  const ignored = []
  let m
  let cursor = 0
  while ((m = pair.exec(text)) !== null) {
    // Anything skipped over between matches is prose, not an option: collect it so the caller can say
    // what it ignored instead of silently swallowing half the input.
    const gap = text.slice(cursor, m.index).trim()
    if (gap) ignored.push(...gap.split(/\s+/))
    cursor = pair.lastIndex
    if (m[7]) { out[m[7]] = true; pairs++; continue }
    const key = m[2]
    const quoted = m[4] ?? m[5]
    if (quoted !== undefined) { out[key] = quoted; pairs++; continue }
    try {
      out[key] = JSON.parse(m[3])
    } catch {
      out[key] = m[3]
    }
    pairs++
  }
  const tail = text.slice(cursor).trim()
  if (tail) ignored.push(...tail.split(/\s+/))
  return { options: out, pairs, ignored }
}

// Kept as the plain-object view for callers that only want the options.
export function parsePairs(text) {
  return parseOptions(text).options
}


/**
 * Normalize whatever arrived into an options object.
 *
 * `warn` is called with one human sentence per degradation and must not throw — engines pass their
 * `log`. It is called on the recovered forms too, deliberately: a run that silently accepted a
 * shape it had to repair teaches the next caller nothing.
 */
export function normalizeArgs(args, warn = () => {}) {
  if (args && typeof args === 'object' && !Array.isArray(args)) return args
  if (typeof args !== 'string' || !args.trim()) return {}
  const text = args.trim()
  // A JSON scalar or array is not an options object, and must not be mistaken for the key=value form
  // below: `[1,2,3]` and `"a sentence"` would otherwise become flags named after their own contents.
  if (text.startsWith('[') || text.startsWith('"')) {
    warn(`⚠️ args arrived as a JSON value that is not an object (${text.slice(0, 40)}) — ALL options ignored, running with defaults`)
    return {}
  }
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        warn('⚠️ args arrived as a JSON string, not an object — parsed it; pass a real object to avoid this')
        return parsed
      }
      warn('⚠️ args arrived as a non-object JSON value — ALL options ignored, running with defaults')
      return {}
    } catch (e) {
      warn(`⚠️ args arrived as a string that looks like JSON but is not (${String((e && e.message) || e).slice(0, 60)}) — ALL options ignored, running with defaults`)
      return {}
    }
  }
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
