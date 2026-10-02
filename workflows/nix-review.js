export const meta = {
  name: 'nix-review',
  description: 'Nix-pinned entry to the generic review engine — reviews only the Nix files in a diff. Prefer `review` (auto-detects language); use this to force a Nix-only pass.',
  whenToUse: 'Explicit Nix-only diff review; the generic default is `review`. Same args as `review`: repo=<absolute path> to review ANOTHER repository (without it every git command runs in the checkout the session itself sits in), base, intent, comment, strict, and path=<repo-relative pathspec> to narrow the scope INSIDE that repo.',
  phases: [{ title: 'Review', detail: 'delegates to the review engine pinned to the nix profile' }],
}

// ---- args ----
// The thin pin normalizes too, and it MUST: it hands the child a real object, so a string arg
// dropped here reaches `review` as a valid-looking shape that its own normalizer cannot warn about.
// A caller typing `base=v0.17.0` would get a confident verdict over the working tree with no line
// anywhere saying the base was gone — the exact failure this shared parser exists to end, surviving
// in the two engines the record-filing roster does not name.
// >>> craft-inline lib/workflow-args.mjs applyOption parseOptions normalizeJsonArgs normalizeKeyValueArgs normalizeArgs
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
function applyOption(m, out, ignored) {
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
function parseOptions(text) {
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

// normalizeArgs' branch for a string that starts with `{`.
/**
 * @param {string} text
 * @param {(msg: string) => void} warn
 * @returns {Record<string, unknown>}
 */
function normalizeJsonArgs(text, warn) {
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
function normalizeKeyValueArgs(text, warn) {
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
function normalizeArgs(args, warn = () => {}) {
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
// <<< craft-inline

// The delegation resolves the child under whichever name this registry carries — the fence's own
// comment states the rule and the fallback's single trigger.
// >>> craft-inline lib/nested-workflow.mjs nestedWorkflow
// Launches a nested workflow under the name that resolves where this engine actually runs. In the
// installed plugin the registry lists engines under the plugin prefix, and a launch by the bare
// name refuses to resolve — observed live: the review pins ran zero agents, and rust-audit's two
// nested reviews died inside its fan-out (realm @nick/craft, node #83). In a checkout of this repo
// the same engines are registered bare. So: the qualified name first, the bare one as fallback.
// The fallback fires ONLY on the sandbox's name-resolution refusal — `workflow()` THROWS on an
// unknown name (documented contract), and the refusal observed live reads `no workflow with that
// name` — never on the nested run itself failing: relaunching a failed review under the second
// spelling would run the whole review twice. A `null` return is a nested engine that died, not a
// missing name — no fallback there either. And when NEITHER spelling resolves, the throw names
// both attempts AND carries the last refusal verbatim — its `Available:` listing is the diagnosis
// that located the live failure at a consumer — so the caller fails loud instead of skipping the
// review, and the record distinguishes a name that would not resolve from a run that died.
/**
 * @param {(name: string, args: unknown) => Promise<unknown>} workflow
 * @param {string} name
 * @param {unknown} args
 * @param {(msg: string) => void} [warn]
 * @returns {Promise<unknown>} the nested run's result — `null` when it died
 */
async function nestedWorkflow(workflow, name, args, warn = () => {}) {
  /** @param {unknown} e @returns {unknown} the refusal's message, or the thrown value itself */
  const messageOf = e => (e && /** @type {{ message?: unknown }} */ (e).message) || e
  /** @param {unknown} e */
  const unresolved = e => /no workflow with that name/i.test(String(messageOf(e)))
  try {
    return await workflow(`craft:${name}`, args)
  } catch (e) {
    if (!unresolved(e)) throw e
    warn(`nested workflow 'craft:${name}' did not resolve here — retrying as '${name}'`)
    try {
      return await workflow(name, args)
    } catch (e2) {
      if (unresolved(e2)) {
        throw new Error(`nested workflow '${name}': neither 'craft:${name}' nor '${name}' resolved — the nested run did NOT happen (last refusal: ${String(messageOf(e2))})`)
      }
      throw e2
    }
  }
}
// <<< craft-inline

// Thin pin over the generic engine (review.js holds the engine + PROFILES registry). Invoked only as
// a root (humans/agents), so it never nests (workflow() nesting is one level only).
return await nestedWorkflow(workflow, 'review', { ...normalizeArgs(args, log), languages: ['nix'] }, log)
