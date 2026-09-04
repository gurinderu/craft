export const meta = {
  name: 'rust-review',
  description: 'Rust-pinned entry to the generic review engine — reviews only the Rust files in a diff. Prefer `review` (auto-detects language); use this to force a Rust-only pass.',
  whenToUse: 'Explicit Rust-only diff review; the generic default is `review`. Same args as `review` (base, intent, comment, path, strict).',
  phases: [{ title: 'Review', detail: 'delegates to the review engine pinned to the rust profile' }],
}

// ---- args ----
// The thin pin normalizes too, and it MUST: it hands the child a real object, so a string arg
// dropped here reaches `review` as a valid-looking shape that its own normalizer cannot warn about.
// A caller typing `base=v0.17.0` would get a confident verdict over the working tree with no line
// anywhere saying the base was gone — the exact failure this shared parser exists to end, surviving
// in the two engines the record-filing roster does not name.
// >>> craft-inline lib/workflow-args.mjs parseOptions normalizeArgs
// Only `key=value` counts as an option, and that is a deliberate narrowing rather than a limitation.
// A bare word cannot become a flag: once any pair is present, the rest of an unquoted sentence would
// otherwise turn into options nobody wrote — `base=v1 intent=review the auth refactor strict` would
// invent `strict`, and an invented `strict` changes what the run does. A flag is written `strict=true`
// or `--strict`; a leading dash is an unambiguous statement of intent, a bare word is not.
function parseOptions(text) {
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
    // Self-contained on purpose: a module-level helper would not be copied into the engines' inlined
    // regions unless it were exported, and the fence's sibling check only knows about EXPORTS — a
    // private helper reaches every engine as a ReferenceError on first use, with the gate green.
    const banned = k => k === '__proto__' || k === 'constructor' || k === 'prototype'
    if (m[7]) { if (banned(m[7])) ignored.push(m[7]); else { out[m[7]] = true; pairs++ } ; continue }
    const key = m[2]
    // `__proto__` is a live setter on a plain object: `__proto__={"craftRoot":"/evil"}` stores no own
    // key and yet makes `A.craftRoot` read `/evil`, which is interpolated into the shell instructions
    // the logger agent is handed. The args string is model-composed, so this is the same threat shape
    // as a model-supplied path, reached by a quieter door. A null-prototype object does not fix it on
    // its own — `Object.assign` back to a plain object re-triggers the setter — and these are never
    // legitimate option names, so they are refused by name and reported.
    if (banned(key)) { ignored.push(key); continue }
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

function normalizeArgs(args, warn = () => {}) {
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
// <<< craft-inline

// Thin pin over the generic engine. review.js holds the engine + PROFILES registry; this just
// restricts it to the rust profile. Invoked only as a root (humans/agents) — rust-audit calls
// `review` directly, so this never nests (workflow() nesting is one level only).
return await workflow('review', { ...normalizeArgs(args, log), languages: ['rust'] })
