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

export function parsePairs(text) {
  // `key=value key2="value with spaces" flag` — the shell-ish form. Values may be bare, single- or
  // double-quoted; a bare key is a flag; a value that parses as JSON (a list, a number, a boolean)
  // becomes that, so `languages=["rust"]` and `mutants=true` mean what they look like.
  //
  // Built here rather than at module scope for two reasons, and both bit: a `/g` regex carries
  // `lastIndex` between calls, so a second parse would resume mid-string; and only exported
  // declarations are copied into the engines' inlined regions, so a module-level const would arrive
  // as a ReferenceError at the first call in every engine.
  const pair = /(\w[\w-]*)=("([^"]*)"|'([^']*)'|[^\s]+)|(\w[\w-]*)/g
  const out = {}
  let m
  while ((m = pair.exec(text)) !== null) {
    if (m[5]) { out[m[5]] = true; continue }
    const raw = m[3] ?? m[4] ?? m[2]
    // A quoted value is taken literally: `intent="[draft] fix"` is a sentence, not a JSON array.
    if (m[3] !== undefined || m[4] !== undefined) { out[m[1]] = raw; continue }
    try {
      out[m[1]] = JSON.parse(raw)
    } catch {
      out[m[1]] = raw
    }
  }
  return out
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
  // At least one real `key=value` is required before this is read as the pair form. A string with no
  // `=` at all is prose — a pasted intent, a sentence, a typo — and turning its words into flags
  // would invent options the caller never wrote, which is worse than dropping them: an invented
  // `strict` or `fresh` changes what the run does.
  const pairs = text.includes('=') ? parsePairs(text) : {}
  if (Object.values(pairs).some(v => v !== true)) {
    warn('⚠️ args arrived as a key=value string — parsed it; pass a real object to avoid this')
    return pairs
  }
  // Reaching here means a non-empty string that is neither JSON nor a single recognizable pair. The
  // loud path matters more than it looks: this is the branch a typo lands in, and defaults produce a
  // verdict that reads exactly like a requested one.
  warn(`⚠️ args arrived as an unrecognized string (${text.slice(0, 40)}) — ALL options ignored, running with defaults`)
  return {}
}
