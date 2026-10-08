export const meta = {
  name: 'rust-audit',
  description: 'Full Rust crate audit — per-crate review, inter-crate contracts, architecture, crate decomposition, security, Miri, semver, build-matrix, deps, unused-crate detection (verified), and test/doc health in parallel, synthesized into one report',
  whenToUse: 'Before a release or a big merge, when you want the comprehensive full review — every craft dimension run at once and consolidated into a single verdict. Pass {base} to fix the diff base; {priorDecisions: [<recalled decision records>]} — an object argument only; a string is refused by the nested reviews — is handed to the nested reviews. The engine itself always recalls the active decisions and questions for the paths of the diff through the craft:memory skill, once, and hands them to the nested reviews, which do not recall again; priorDecisions is optional and ADDS to that recall, never replaces it (merged by id, the recalled record kept on a clash; an empty list adds nothing; a passed record may leave out id when it carries kind, title and scope, the id then derived from them by the memory skill rule), and the report names both parts. Pass {mutants:true} to include the slow mutation pass. It audits ONLY the checkout the session runs in: there is no `repo` argument, and passing one is refused with nothing run (use `craft:review` with repo=, or start a session inside that repository). It posts nothing to a PR: to post findings there run review with comment — never post findings by hand (they would lack the marker that ties a later rejection to its finding).',
  phases: [
    { title: 'Scout', detail: 'detect the diff base, unsafe code, and the workspace crates + dependency edges', model: 'haiku' },
    { title: 'Audit', detail: 'parallel per-crate review + per-edge contracts + architecture + crate-decomposition + security + Miri + semver/build-matrix/deps/unused-crates/tests-cov' },
    { title: 'Verify', detail: 'adversarially verify unused-crate candidates before reporting' },
    { title: 'Synthesize', detail: 'merge every dimension into one severity-ranked report' },
  ],
}

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

const OBJECT_ONLY_OPTIONS = ['priorDecisions']

/**
 * @param {string} text
 * @returns {{ options: Record<string, unknown>, pairs: number, ignored: string[], cut: string }}
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
    const gap = text.slice(cursor, m.index).trim()
    if (gap) ignored.push(...gap.split(/\s+/))
    const key = String(m[2] ?? m[7])
    if (OBJECT_ONLY_OPTIONS.includes(key)) { out[key] = text.slice(m.index); return { options: out, pairs: pairs + 1, ignored, cut: key } }
    cursor = pair.lastIndex
    pairs += applyOption(m, out, ignored)
  }
  const tail = text.slice(cursor).trim()
  if (tail) ignored.push(...tail.split(/\s+/))
  return { options: out, pairs, ignored, cut: '' }
}

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

/**
 * @param {string} text
 * @param {(msg: string) => void} warn
 * @returns {Record<string, unknown>}
 */
function normalizeKeyValueArgs(text, warn) {
  const { options, pairs, ignored, cut } = parseOptions(text)
  if (cut) warn(`⚠️ ${cut} arrived in the key=value string — it and everything after it were not read as options (its value cannot be delimited there); pass args as an object`)
  if (pairs) {
    warn('⚠️ args arrived as a key=value string — parsed it; pass a real object to avoid this')
    if (ignored.length) {
      warn(`⚠️ ignored ${ignored.length} word(s) in args that are not options (${ignored.slice(0, 6).join(' ')}) — quote a value that contains spaces`)
    }
    return options
  }
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
  if (text.startsWith('[') || text.startsWith('"')) {
    warn(`⚠️ args arrived as a JSON value that is not an object (${text.slice(0, 40)}) — ALL options ignored, running with defaults`)
    return {}
  }
  if (text.startsWith('{')) return normalizeJsonArgs(text, warn)
  return normalizeKeyValueArgs(text, warn)
}
const A = normalizeArgs(args, log)

/** A text argument: its string form when given (truthy), else ''. @param {string} key @returns {string} */
function textArg(key) {
  return A[key] ? String(A[key]) : ''
}

const baseArg = textArg('base')
const runMutants = !!A['mutants']
const craftRootArg = textArg('craftRoot')
/** @param {string} text @returns {number[]} */
function utf8Bytes(text) {
  /** @type {number[]} */
  const out = []
  for (const ch of text) {
    let cp = /** @type {number} */ (ch.codePointAt(0))
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd
    if (cp < 0x80) out.push(cp)
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f))
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
  }
  return out
}
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

/** @param {number} x @param {number} n */
const rotr = (x, n) => (x >>> n) | (x << (32 - n))

/** The 32-bit word at `i` of `a`, 0 past its end. @param {number[]} a @param {number} i */
const word = (a, i) => a[i] ?? 0

/** The 64-word message schedule of the 64-byte block at `at`. @param {number[]} bytes @param {number} at @returns {number[]} */
function sha256Schedule(bytes, at) {
  /** @type {number[]} */
  const w = []
  for (let i = 0; i < 16; i++) w[i] = (word(bytes, at + 4 * i) << 24) | (word(bytes, at + 4 * i + 1) << 16) | (word(bytes, at + 4 * i + 2) << 8) | word(bytes, at + 4 * i + 3)
  for (let i = 16; i < 64; i++) {
    const [a, b] = [word(w, i - 15), word(w, i - 2)]
    const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)
    const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10)
    w[i] = (word(w, i - 16) + s0 + word(w, i - 7) + s1) | 0
  }
  return w
}

/** One 64-byte block folded into the state `h`. @param {number[]} h @param {number[]} bytes @param {number} at */
function sha256Block(h, bytes, at) {
  const w = sha256Schedule(bytes, at)
  let [a, b, c, d, e, f, g, k] = /** @type {[number, number, number, number, number, number, number, number]} */ (h.slice())
  for (let i = 0; i < 64; i++) {
    const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + word(SHA256_K, i) + word(w, i)) | 0
    const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0
    k = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0
  }
  ;[a, b, c, d, e, f, g, k].forEach((v, i) => { h[i] = (word(h, i) + v) | 0 })
}

/** The sha256 of a string's UTF-8 bytes, as 64 lower-case hex chars. @param {string} s @returns {string} */
function sha256Hex(s) {
  const bytes = utf8Bytes(s)
  const bits = bytes.length * 8
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  bytes.push(0, 0, 0, 0, (bits >>> 24) & 255, (bits >>> 16) & 255, (bits >>> 8) & 255, bits & 255)
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  for (let at = 0; at < bytes.length; at += 64) sha256Block(h, bytes, at)
  return h.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('')
}

/**
 * The memory skill's id of a record of `kind` with `title` and `scope`.
 * @param {string} kind @param {string} title @param {string} scope @returns {string}
 */
function memoryRecordId(kind, title, scope) {
  const t = title.trim().replace(/\s+/g, ' ').toLowerCase()
  const s = scope.trim().replace(/^\.\//, '').replace(/\/+$/, '')
  return `${kind}-${sha256Hex(`${kind}\n${t}\n${s}`).slice(0, 10)}`
}
const DECISION_FIELD_MAX = { id: 80, title: 200, scope: 300, reason: 1200, who: 120, when: 40, link: 500 }

const DECISION_LENS_MAX = 80

const DECISION_TOOL_RULE_MAX = 120

/**
 * A record's `line`: a non-negative integer, or a string of digits; 0 when absent (0 is "no line", as
 * in a finding); -1 when malformed. @param {unknown} v @returns {number}
 */
function recordLine(v) {
  if (v == null || v === '') return 0
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 && v < 1e9 ? v : -1
  return typeof v === 'string' && /^\s*\d{1,9}\s*$/.test(v) ? Number(v) : -1
}

/** What is wrong with a record's anchor (`line`, `lens`, `toolRule`); '' when nothing is. @param {Record<string, unknown>} o @returns {string} */
function anchorFieldProblem(o) {
  if (recordLine(o['line']) < 0) return `: line ${JSON.stringify(o['line'])} is not a line number`
  return anchorTextProblem(o, 'lens', DECISION_LENS_MAX) || anchorTextProblem(o, 'toolRule', DECISION_TOOL_RULE_MAX)
}

/** What is wrong with a text field of the anchor; '' when it is absent or fit. @param {Record<string, unknown>} o @param {string} k @param {number} max @returns {string} */
function anchorTextProblem(o, k, max) {
  const v = o[k]
  if (v == null) return ''
  if (typeof v !== 'string') return `: ${k} ${JSON.stringify(v)} is not a string`
  if (v.trim().length > max) return `: ${k} is ${v.trim().length} chars, over the ${max}-char ceiling`
  return hasControlChar(v) ? `: ${k} contains a control character` : ''
}

const PRIOR_RECORD_KINDS = ['decision', 'question']

/** Path segments with `.`, empty segments and separators folded; `..` kept literal. @param {string} p */
function decisionScopeParts(p) {
  return p.split(/[\\/]+/).filter(s => s && s !== '.')
}

/** @param {unknown} v @returns {string} */
function decisionText(v) {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * A record's kind, lower-cased; a record without one takes the kind its id prefix names, for every
 * kind of the memory skill (id = `<kind>-<hash>`: `decision-`, `question-`, `lesson-`), and is a
 * `decision` only when its id names none — a launcher that leaves `kind` out must not turn a deferral
 * into a rejection, nor a lesson into a decision.
 * @param {Record<string, unknown>} o @returns {string}
 */
function recordKind(o) {
  if (o['kind'] != null) return decisionText(o['kind']).toLowerCase()
  const m = /^(decision|question|lesson)-/i.exec(decisionText(o['id']))
  return m ? String(m[1]).toLowerCase() : 'decision'
}

/**
 * The memory skill's id of a record, from its own kind, title and scope, whatever id it carries (realm
 * @nick/craft, node #222); '' when it lacks any of the three — no scope is guessed.
 * @param {Record<string, unknown>} o @returns {string}
 */
function skillRecordId(o) {
  const [kind, title, scope] = [decisionText(o['kind']).toLowerCase(), decisionText(o['title']), decisionText(o['scope'])]
  return kind && title && scope ? memoryRecordId(kind, title, scope) : ''
}

/**
 * The id a record without one gets by the memory skill's rule (skillRecordId); '' when it has an id or
 * lacks any of kind, title and scope. @param {Record<string, unknown>} o @returns {string}
 */
function derivedRecordId(o) {
  return decisionText(o['id']) ? '' : skillRecordId(o)
}

/** The record's id: its own, else the derived one, else ''. @param {Record<string, unknown>} o @returns {string} */
function recordId(o) {
  return decisionText(o['id']) || derivedRecordId(o)
}

/** The ids a record's `supersedes: <id>` and `answers: <id>` links name. @param {unknown[]} links @returns {string[]} */
function supersededIds(links) {
  return linkedIds(links, /^(?:supersedes|answers):\s*(\S+)$/i)
}

/** The ids the links matching `re` (its group 1) name. @param {unknown[]} links @param {RegExp} re @returns {string[]} */
function linkedIds(links, re) {
  return links.flatMap(l => {
    const m = re.exec(decisionText(l))
    return m ? [String(m[1])] : []
  })
}

/**
 * The decision's fields as strings, trimmed. A memory record (skills/memory) is read as it is
 * recalled: `body`, `date` and `author` stand in for `reason`, `when` and `who`, and the first
 * http(s) URL in `links` for `link`. `kind` is `question` only when recordKind reads one; `deferred` only
 * a boolean `true`.
 * @param {Record<string, unknown>} o @returns {PriorDecision}
 */
function decisionFields(o) {
  /** @param {string} k @param {string} [alt] */
  const f = (k, alt = '') => decisionText(o[k]) || decisionText(o[alt])
  const links = Array.isArray(o['links']) ? o['links'] : []
  const url = decisionText(links.find(l => /^https?:\/\//.test(decisionText(l))))
  const derived = derivedRecordId(o)
  const stores = linkedIds(links, /^store:\s*(\S+)$/i)
  return { id: f('id') || derived, title: f('title'), scope: f('scope') || '.', reason: f('reason', 'body'), who: f('who', 'author'), when: f('when', 'date'), link: f('link') || url, commit: f('commit'), kind: recordKind(o) === 'question' ? 'question' : 'decision', deferred: o['deferred'] === true, supersedes: supersededIds(links), ...(stores.length ? { stores } : {}), ...(derived ? { derived: /** @type {const} */ (true) } : {}), ...recordAnchor(o) }
}

/**
 * The record's anchor and overrides, each present only when given: `line` above 0, `lens` and `toolRule`
 * non-empty (realm @nick/craft, node #236), `overrides` the ids of a list of strings. @param {Record<string, unknown>} o
 * @returns {{ line?: number, lens?: string, toolRule?: string, overrides?: string[] }}
 */
function recordAnchor(o) {
  const line = recordLine(o['line'])
  const lens = decisionText(o['lens'])
  const toolRule = decisionText(o['toolRule'])
  const overrides = Array.isArray(o['overrides']) ? o['overrides'].map(decisionText).filter(Boolean) : []
  return { ...(line > 0 ? { line } : {}), ...(lens ? { lens } : {}), ...(toolRule ? { toolRule } : {}), ...(overrides.length ? { overrides } : {}) }
}

/**
 * The required fields missing, as the tail of a refusal sentence — only those that are; '' when none
 * is. A record with a title and a reason but no id lacked the kind or the scope its id is derived from
 * (derivedRecordId). @param {PriorDecision} d @returns {string}
 */
function missingFieldProblem(d) {
  if (!d.id && d.title && d.reason) return ' lacks an id, and the kind or the scope its id is derived from'
  const missing = [d.id ? '' : 'an id', d.title ? '' : 'a title', d.reason ? '' : 'a reason'].filter(Boolean)
  return missing.length ? ` lacks ${missing.length > 1 ? `${missing.slice(0, -1).join(', ')} and ` : ''}${missing.at(-1)}` : ''
}

/**
 * What is wrong with a decision, as the tail of a refusal sentence; '' when nothing is.
 * @param {Record<string, unknown>} o @param {PriorDecision} d @returns {string}
 */
function decisionProblem(o, d) {
  if (!PRIOR_RECORD_KINDS.includes(recordKind(o))) return ` is a ${JSON.stringify(recordKind(o))} record, not a decision or a question`
  if (o['status'] != null && decisionText(o['status']) !== 'active') return ` is not active (status ${JSON.stringify(o['status'])})`
  const missing = missingFieldProblem(d)
  if (missing) return missing
  const over = Object.entries(DECISION_FIELD_MAX).find(([k, max]) => d[/** @type {keyof typeof DECISION_FIELD_MAX} */ (k)].length > max)
  if (over) return `: ${over[0]} is ${d[/** @type {keyof typeof DECISION_FIELD_MAX} */ (over[0])].length} chars, over the ${over[1]}-char ceiling`
  return anchorFieldProblem(o) || decisionAnchorProblem(d)
}

const SAFE_SCOPE = /^[A-Za-z0-9._@+/ -]+$/

/** Whether `s` holds a control character (a newline among them). @param {string} s */
function hasControlChar(s) {
  return [...s].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
}

/**
 * The id, the scope and the commit go into a shell line (scopeCheckScript) and the agent prompt that
 * carries it: no control character in any, the scope a repo-relative path of safe characters, the
 * commit a hash. '' when all hold.
 * @param {PriorDecision} d @returns {string}
 */
function decisionAnchorProblem(d) {
  const ctl = /** @type {const} */ (['id', 'scope', 'commit']).find(k => hasControlChar(d[k]))
  if (ctl) return `: ${ctl} contains a control character`
  if (/^([\\/]|~|[A-Za-z]:)/.test(d.scope) || decisionScopeParts(d.scope).includes('..')) return `: scope ${JSON.stringify(d.scope)} is not a repo-relative path`
  if (!SAFE_SCOPE.test(d.scope)) return `: scope ${JSON.stringify(d.scope)} has a character outside letters, digits and ._@+/ -`
  if (d.commit && !/^[0-9a-f]{7,40}$/i.test(d.commit)) return `: commit ${JSON.stringify(d.commit)} is not a commit hash`
  return ''
}

/**
 * One decision as given, checked: a refusal sentence, or the decision. `at` is its index in the list,
 * or the label a refusal opens with (lib/memory-recall.mjs names the part it came from).
 * @param {unknown} raw @param {number | string} at @returns {PriorDecision | string}
 */
function readPriorDecision(raw, at) {
  const label = typeof at === 'number' ? `decision #${at}` : at
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return `${label} is not an object`
  const o = /** @type {Record<string, unknown>} */ (raw)
  const d = decisionFields(o)
  const problem = decisionProblem(o, d)
  return problem ? `${label}${d.id && !hasControlChar(d.id) ? ` (${d.id})` : ''}${problem}` : d
}
const PRIOR_DECISIONS_MAX = 100

/** A refusal's label for the record at index `i`. @param {number} i @returns {string} */
const decisionLabel = i => `decision #${i}`

/** The record's id (its own, else the derived one) when it is fit to print, else ''. @param {unknown} item @returns {string} */
function printableId(item) {
  const id = item && typeof item === 'object' && !Array.isArray(item) ? recordId(/** @type {Record<string, unknown>} */ (item)) : ''
  return id && id.length <= DECISION_FIELD_MAX.id && !hasControlChar(id) ? id : ''
}

/**
 * The records past the cap, each named (its label and id), the names bounded by the cap itself.
 * @param {unknown[]} cut @param {(i: number) => string} labelOf @returns {string}
 */
function cutNames(cut, labelOf) {
  const named = cut.slice(0, PRIOR_DECISIONS_MAX).map((item, k) => {
    const id = printableId(item)
    return `${labelOf(PRIOR_DECISIONS_MAX + k)}${id ? ` (${id})` : ''}`
  })
  const more = cut.length - named.length
  return `${named.join(', ')}${more ? ` and ${more} more` : ''}`
}

/**
 * The `priorDecisions` argument (or a recall's answer merged with it), checked. Absent → nothing of it applied, no refusal
 * (the engine's own recall still runs: lib/memory-recall.mjs). Anything else that is not a list → nothing applied, each problem named.
 * @param {unknown} raw @param {(i: number) => string} [labelOf] how a refusal names the record at index i
 * @returns {{ decisions: PriorDecision[], refused: string[] }}
 */
function parsePriorDecisions(raw, labelOf = decisionLabel) {
  if (raw == null || raw === '') return { decisions: [], refused: [] }
  if (typeof raw === 'string') return { decisions: [], refused: ['priorDecisions arrived as a string — only a list inside an object argument is read (in a key=value string nothing from priorDecisions on was read as an option) — no decision applied'] }
  const list = raw
  if (!Array.isArray(list)) return { decisions: [], refused: ['priorDecisions is not a list — no decision applied'] }
  /** @type {PriorDecision[]} */
  const decisions = []
  /** @type {string[]} */
  const refused = []
  list.slice(0, PRIOR_DECISIONS_MAX).forEach((item, i) => {
    const d = readPriorDecision(item, labelOf(i))
    if (typeof d === 'string') refused.push(d)
    else if (decisions.some(x => x.id === d.id)) refused.push(`${labelOf(i)} (${d.id}) repeats an id already given — not applied`)
    else decisions.push(d)
  })
  if (list.length > PRIOR_DECISIONS_MAX) {
    refused.push(`${list.length - PRIOR_DECISIONS_MAX} decision(s) past the cap of ${PRIOR_DECISIONS_MAX} were not applied — findings they would answer are raised normally: ${cutNames(list.slice(PRIOR_DECISIONS_MAX), labelOf)}`)
  }
  return { decisions, refused }
}
const RECALL_PATHS_MAX = 60

const RECORD_TEXT_FIELDS = ['id', 'kind', 'title', 'body', 'scope', 'status', 'date', 'author', 'commit', 'lens', 'toolRule']

const RECORD_OTHER_FIELDS = { line: { type: 'integer' }, deferred: { type: 'boolean' }, links: { type: 'array', items: { type: 'string' } } }

const MEMORY_RECALL_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['backend', 'why', 'decisions'],
  properties: {
    backend: { type: 'string', description: 'the memory backend recall used, or none' },
    why: { type: 'string', description: 'one line: the rule that chose the backend, or why there is none, or that recall found nothing' },
    decisions: {
      type: 'array', description: 'the matching active decision records, verbatim',
      items: { type: 'object', properties: { ...Object.fromEntries(RECORD_TEXT_FIELDS.map(k => [k, { type: 'string' }])), ...RECORD_OTHER_FIELDS } },
    },
    questions: {
      type: 'array', description: 'the matching active question records (open questions, deferred findings among them), verbatim',
      items: { type: 'object', properties: { ...Object.fromEntries(RECORD_TEXT_FIELDS.map(k => [k, { type: 'string' }])), ...RECORD_OTHER_FIELDS } },
    },
    stale: {
      type: 'array', description: 'matching active decisions that no longer hold against the code, left out of decisions and NOT superseded',
      items: { type: 'object', properties: { id: { type: 'string' }, why: { type: 'string' } } },
    },
    inactive: {
      type: 'array', description: 'matching superseded or withdrawn records, named only — never applied; they hold back a passed copy not dated later',
      items: { type: 'object', properties: Object.fromEntries(['id', 'storeId', 'kind', 'title', 'scope', 'status', 'date'].map(k => [k, { type: 'string' }])) },
    },
  },
}

/**
 * The recall agent's prompt: the skill first, its backend order when the skill is unavailable.
 * @param {string[]} paths the diff's changed paths; none → the agent lists them from the base
 * @param {string} base @returns {string}
 */
function memoryRecallPrompt(paths, base) {
  const listed = paths.slice(0, RECALL_PATHS_MAX)
  const cut = paths.length - listed.length
  const scope = listed.length
    ? `these changed paths of the diff:\n${listed.map(p => `- ${p}`).join('\n')}${cut ? `\n(${cut} more path(s) cut at the bound of ${RECALL_PATHS_MAX} — not recalled for)` : ''}`
    : `the paths of \`git diff --name-only ${base || '$(git merge-base origin/main HEAD)'}...HEAD\``
  return `Recall the remembered decisions and open questions of this project for a code review. READ ONLY: write, record, edit or create nothing anywhere (no memory record, no file, no MCP create call).
Scope: ${scope}
1. Invoke the craft:memory skill with the Skill tool and run its recall for those paths, no topic, status active only: once for kind decision, once for kind question. Then find the decision and question records for those paths whose status is superseded or withdrawn (the recall's history, or the backend's search filtered by status) — only to name them in inactive, never in decisions or questions.
2. If that skill is unavailable, follow its backend order yourself; the first that applies wins: (a) an explicit setting, env CRAFT_MEMORY, else a line \`craft-memory: <value>\` in AGENTS.md or CLAUDE.md at the repo root (mcp | harness | repo | none; a pinned backend that is unavailable means none); (b) a connected memory or knowledge-graph MCP server found by capability: load the deferred tools of the session with ToolSearch and take a server whose tools offer both a search over stored items and a create of a new item, judged by what the tools do, never by a server or tool name; use only its search; (c) the project memory files of the harness: Claude Code keeps them in \`~/.claude/projects/<slug>/memory/\` with \`MEMORY.md\` as the index, keyed by the repository's main checkout, never a worktree or subdirectory: root = \`dirname "$(git rev-parse --path-format=absolute --git-common-dir)"\`, \`pwd\` only outside a git repo; <slug> = root with every character that is not an ASCII letter or digit replaced by \`-\` (for example \`/home/alice/src/app\` → \`-home-alice-src-app\`) — an observed convention, not a documented one; \`~/.claude/projects/<slug>/memory\` must exist: read MEMORY.md, then only the matching files; else say \`none — harness memory directory <path>/memory not found\` and never guess a near match; (d) \`.craft/memory/decision/\` and \`.craft/memory/question/\` in the repo. None applies: backend none.
3. A record matches a path when its scope equals the path, is a directory containing it, names its component, or is \`.\`.
4. A stale matching decision — one that no longer holds against the code as it is now (its reason is gone): supersede nothing — leave it out of decisions and list it in stale as {id, why}; superseding stays with craft:addressing-findings.
Return {backend, why, decisions, questions, stale, inactive}: backend names the store used (or none); why is one line naming the rule that chose it, or why there is none, or that recall found nothing; decisions are the matching active decision records verbatim in the record shape id, kind, title, body, scope, status, date, author, commit, deferred, line, lens, toolRule, links (line, lens and toolRule only when the record carries them; nothing rewritten or summarised; [] when none) — kind, title and scope always as stored; when the store keeps its own id for a record, add it to links as \`store: <id>\` (the review sets the record id from kind, title and scope itself); questions are the matching active question records in the same shape, verbatim ([] when none); stale is [] when none; inactive is the matching superseded or withdrawn records as {id, storeId, kind, title, scope, status, date} — storeId the store's own id when it keeps one, date the store's last-write date of that record as YYYY-MM-DD or full ISO ([] when none): the review holds back any record it is handed that is one of them, unless the handed record is dated later.`
}

/**
 * Where the decisions came from: `recalled` by this engine, `launcher` — recalled by the engine that
 * launched this one (`_recalled`), or `none`; `passed` counts the launcher's own records (accepted on
 * their own, or as forwarded by the launching audit), `added` those of them the recall did not already
 * hold (under `launcher`: those of them applied; the cap's refusals are named in their own section);
 * `derived` the applied records whose id was derived, their own having none, and `derivedNamed` the
 * first DERIVED_NAMED_MAX of them as `<id> (<title, cut>)`.
 * @typedef {{ source: 'recalled' | 'launcher' | 'none', count: number, why: string, questions?: number, passed?: number, added?: number, derived?: number, derivedNamed?: string[] }} MemorySource
 */
/** @param {unknown} v @returns {string} */
const recallText = v => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')

/** The stale decisions the agent left out, as one line's tail. @param {unknown} list @returns {string} */
function staleTail(list) {
  const named = (Array.isArray(list) ? list : []).flatMap(x => {
    const r = /** @type {Record<string, unknown>} */ (x && typeof x === 'object' ? x : {})
    const id = recallText(r['id'])
    return id ? [`${id} (${recallText(r['why']) || 'no reason given'})`] : []
  })
  return named.length ? `; stale, left out: ${named.join(', ')}` : ''
}

/**
 * The recalled questions, each tagged `kind: question` when it carries no kind (an object without one
 * is still a question: it came back in that list). @param {unknown} list @returns {unknown[]}
 */
function recalledQuestions(list) {
  return (Array.isArray(list) ? list : []).map(q => (q && typeof q === 'object' && !Array.isArray(q) && !('kind' in q) ? { ...q, kind: 'question' } : q))
}

const SKILL_ID_FORM = /^(decision|question|lesson)-[0-9a-f]{10}$/

/**
 * A recalled record with the skill's id set by the engine: one that carries a `store: <id>` link, or an
 * id not of the skill's form (a store's own), gets skillRecordId — the store's id kept in links as
 * `store: <id>` — so `answers:`/`supersedes:` links match (realm @nick/craft, node #215). A record without
 * an id, or one whose kind, title or scope is missing, is left as it is. @param {unknown} x @returns {unknown}
 */
function withSkillId(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return x
  const o = /** @type {Record<string, unknown>} */ (x)
  const links = Array.isArray(o['links']) ? o['links'] : []
  const stored = links.some(l => /^store:\s*\S/i.test(decisionText(l)))
  const sid = engineRecordId(o, stored)
  return sid ? { ...o, id: sid, links: stored ? links : [...links, `store: ${decisionText(o['id'])}`] } : x
}

/**
 * The id withSkillId sets: skillRecordId when the record's own id differs from it and is a store's (a
 * `store:` link beside it, or not of the skill's form); '' when the record keeps its own.
 * @param {Record<string, unknown>} o @param {boolean} stored @returns {string}
 */
function engineRecordId(o, stored) {
  const [id, sid] = [decisionText(o['id']), skillRecordId(o)]
  return id && sid && sid !== id && (stored || !SKILL_ID_FORM.test(id)) ? sid : ''
}

/**
 * A record the store withdrew or superseded, as the recall named it: every id it is known by (its own,
 * the store's, the skill's from kind, title and scope), its status and its last-write date ('' when none).
 * @typedef {{ ids: string[], status: string, date: string }} InactiveRecord
 */
/** The recall's `inactive` list, read; an entry without any id is dropped. @param {unknown} list @returns {InactiveRecord[]} */
function inactiveRecords(list) {
  return (Array.isArray(list) ? list : []).flatMap(x => {
    const o = /** @type {Record<string, unknown>} */ (x && typeof x === 'object' && !Array.isArray(x) ? x : {})
    const ids = [...new Set([decisionText(o['id']), decisionText(o['storeId']), skillRecordId(o)].filter(Boolean))]
    return ids.length ? [{ ids, status: recallText(o['status']) || 'inactive', date: recallText(o['date']) }] : []
  })
}

/**
 * What the recall agent returned, read: the decisions and questions to hand to parsePriorDecisions (a
 * list, possibly empty, each id set by withSkillId), the inactive records that hold back a passed copy,
 * and the source to report. A dead or off-shape answer applies nothing and is named.
 * @param {unknown} raw @param {number} cut paths past RECALL_PATHS_MAX
 * @returns {{ decisions: unknown[], memory: MemorySource, inactive: InactiveRecord[] }}
 */
function readMemoryRecall(raw, cut) {
  const r = /** @type {Record<string, unknown>} */ (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {})
  const tail = cut > 0 ? `; ${cut} changed path(s) past the bound of ${RECALL_PATHS_MAX} were not recalled for` : ''
  const list = r['decisions']
  const inactive = inactiveRecords(r['inactive'])
  if (!Array.isArray(list)) return { decisions: [], inactive, memory: { source: 'none', count: 0, why: `the recall agent died or returned no decision list, so nothing recalled was applied — findings are raised normally${tail}` } }
  const backend = recallText(r['backend']) || 'an unnamed backend'
  const why = recallText(r['why']) || 'no reason given'
  const stale = staleTail(r['stale'])
  const questions = recalledQuestions(r['questions'])
  const all = [...list, ...questions].map(withSkillId)
  if (!all.length) return { decisions: [], inactive, memory: { source: 'none', count: 0, why: `${why} (backend ${backend})${stale}${tail}` } }
  return { decisions: all, inactive, memory: { source: 'recalled', count: all.length, why: `${backend} (${why})${stale}${tail}`, ...(questions.length ? { questions: questions.length } : {}) } }
}

/**
 * The source before any recall: not yet recalled, with the launcher's accepted records counted; or, when
 * the launching engine already recalled (`_recalled`), its outcome — `note` is why it found none.
 * @param {number} passed the launcher's records accepted @param {boolean} [recalled] @param {unknown} [note]
 * @returns {MemorySource}
 */
function initialMemory(passed, recalled = false, note = '') {
  if (recalled) return { source: 'launcher', count: passed, why: recallText(note) }
  /** @type {MemorySource} */
  const m = { source: 'none', count: 0, why: 'not recalled — the run ended before its recall step' }
  return passed ? { ...m, passed } : m
}

/**
 * The recalled records with the launcher's appended, one per id: a passed record whose id a WELL-FORMED
 * recalled record already holds is dropped — the recalled one is the store's current state, a status
 * other than active included (it is then applied by neither copy). A malformed recalled record claims no
 * id, so the passed one stands and the reader refuses the recalled one by name (realm @nick/craft, node
 * #218). A record is held under its id and under the one derived from its kind, title and scope
 * (skillRecordId), so a recalled record with a store's own id and a passed copy without one are one;
 * a record with neither is kept, for the reader to refuse by name.
 * `addedAt` is each added record's index in the passed list.
 * @template T @param {T[]} recalled @param {T[]} passed @param {(x: T) => boolean} [readable]
 * @returns {{ merged: T[], addedAt: number[] }}
 */
function mergeById(recalled, passed, readable = () => true) {
  const held = new Set(recalled.filter(x => readable(x)).flatMap(heldIds))
  const addedAt = passed.flatMap((x, i) => (heldIds(x).some(id => held.has(id)) ? [] : [i]))
  return { merged: [...recalled, ...addedAt.map(i => /** @type {T} */ (passed[i]))], addedAt }
}

/** A record's id, and the one derived from its kind, title and scope. @param {unknown} x @returns {string[]} */
function heldIds(x) {
  const o = /** @type {Record<string, unknown>} */ (x && typeof x === 'object' && !Array.isArray(x) ? x : {})
  return [recordId(o), skillRecordId(o)].filter(Boolean)
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?(Z|[+-]\d{2}:\d{2})?)?$/

/** The days of month `m` (1-12) of year `y`. @param {number} y @param {number} m @returns {number} */
function monthDays(y, m) {
  if (m === 2) return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28
  return [4, 6, 9, 11].includes(m) ? 30 : 31
}

/** The day `by` (-1, 0 or 1) days from y-m-d, as YYYY-MM-DD. @param {number} y @param {number} m @param {number} d @param {number} by @returns {string} */
function shiftedDay(y, m, d, by) {
  let [yy, mm, dd] = [y, m, d + by]
  if (dd < 1) [yy, mm] = mm === 1 ? [yy - 1, 12] : [yy, mm - 1]
  if (dd < 1) dd = monthDays(yy, mm)
  if (dd > monthDays(yy, mm)) [yy, mm, dd] = mm === 12 ? [yy + 1, 1, 1] : [yy, mm + 1, 1]
  return `${String(yy).padStart(4, '0')}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
}

/** A zone's offset in minutes east of UTC (none or `Z`: 0); null when out of range. @param {string | undefined} z @returns {number | null} */
function zoneMinutes(z) {
  if (!z || z === 'Z') return 0
  const [h, m] = [Number(z.slice(1, 3)), Number(z.slice(4, 6))]
  return h < 24 && m < 60 ? (z[0] === '-' ? -1 : 1) * (h * 60 + m) : null
}

/**
 * An ISO date read by hand (the engines' sandbox has no `Date`): its UTC day and, for a timestamp, its
 * seconds into that day (a timestamp without a zone is UTC); null when `v` is no ISO date or names a
 * day or time the calendar lacks (2026-02-30, 24:10).
 * @param {string} v @returns {{ day: string, at: number | null } | null}
 */
function isoMoment(v) {
  const p = ISO_DATE.exec(v)
  if (!p) return null
  const [y, m, d] = [Number(p[1]), Number(p[2]), Number(p[3])]
  if (m < 1 || m > 12 || d < 1 || d > monthDays(y, m)) return null
  if (p[4] === undefined) return { day: v, at: null }
  const clock = utcSeconds(p)
  if (clock === null) return null
  const by = clock < 0 ? -1 : clock >= 86400 ? 1 : 0
  return { day: shiftedDay(y, m, d, by), at: clock - by * 86400 }
}

/**
 * A timestamp's time of day in UTC seconds from its own day's midnight (below 0 or past 86400 when the
 * zone moves it to another day); null when the time or the zone is out of range.
 * @param {RegExpExecArray} p ISO_DATE's match @returns {number | null}
 */
function utcSeconds(p) {
  const [h, min, sec, off] = [Number(p[4]), Number(p[5]), Number(p[6] ?? 0), zoneMinutes(p[7])]
  return h > 23 || min > 59 || sec >= 60 || off === null ? null : (h * 60 + min - off) * 60 + sec
}

/**
 * Why passed date `p` does not override record `e` (an inactive copy, or an active successor); '' when
 * it is later (realm @nick/craft, node #229). Two timestamps compare to the instant; otherwise by the
 * UTC day, so a same-day pair is not later.
 * @param {string} p @param {{ status: string, date: string }} e @returns {string}
 */
function notLaterWhy(p, e) {
  const [a, b] = [isoMoment(p), isoMoment(e.date)]
  if (!a) return 'the passed record carries no ISO date to set against it'
  if (!b) return `the ${e.status} record carries no ISO date to compare`
  const sameDayLater = a.day === b.day && a.at != null && b.at != null && a.at > b.at
  return a.day > b.day || sameDayLater ? '' : `the passed record's date ${p} is not later than the ${e.status} record's ${e.date}`
}

/**
 * An active recalled record whose `supersedes:`/`answers:` links name another: its id, date and the ids
 * it names — it opposes a passed copy of a record it names, as the store's inactive copy does.
 * @typedef {{ id: string, status: 'active', date: string, names: string[] }} Successor
 */
/** The successors among the recalled records `active` accepts. @param {unknown[]} recalled @param {(x: unknown) => boolean} active @returns {Successor[]} */
function successorRecords(recalled, active) {
  return recalled.flatMap(x => {
    if (!active(x)) return []
    const o = /** @type {Record<string, unknown>} */ (x)
    const names = supersededIds(Array.isArray(o['links']) ? o['links'] : [])
    return names.length ? [{ id: recordId(o), status: /** @type {const} */ ('active'), date: decisionText(o['date']) || decisionText(o['when']), names }] : []
  })
}

/** Every id a passed record is known by: heldIds and its `store: <id>` links. @param {unknown} x @returns {string[]} */
function passedAliases(x) {
  const o = /** @type {Record<string, unknown>} */ (x && typeof x === 'object' && !Array.isArray(x) ? x : {})
  return [...heldIds(o), ...linkedIds(Array.isArray(o['links']) ? o['links'] : [], /^store:\s*(\S+)$/i)]
}

/**
 * The passed records (those at `only`) an inactive record names (by any of its ids) or an active
 * recalled successor supersedes or answers, each named once (realm @nick/craft, node #224). One stands
 * only when dated later than EVERY record opposing it (node #229): the override is named, `… applied
 * over <what>: newer`, and its aliases go to `freed` — a successor's link to it no longer drops it.
 * Otherwise it is held back: `… not applied: held by <id> (active, <date>) (<why>)` when a successor is
 * not older, else `… not applied: <status> in memory (<why>)`.
 * @param {unknown[]} passed @param {InactiveRecord[]} inactive @param {number[]} [only] @param {Successor[]} [successors]
 * `over` maps each such passed record's index to the ids of the successors it overrides.
 * @returns {{ at: Set<number>, refused: string[], overrides: string[], freed: string[], over: Map<number, string[]> }}
 */
function blockedPassed(passed, inactive, only = passed.map((_, i) => i), successors = []) {
  /** @type {Set<number>} */
  const at = new Set()
  /** @type {{ refused: string[], overrides: string[], freed: string[], over: Map<number, string[]> }} */
  const out = { refused: [], overrides: [], freed: [], over: new Map() }
  for (const i of only) {
    const ids = passedAliases(passed[i])
    const hits = inactive.filter(e => e.ids.some(id => ids.includes(id)))
    const over = successors.filter(s => s.names.some(id => ids.includes(id)))
    if (!hits.length && !over.length) continue
    const label = `passed decision #${i}${idTail(ids[0])}`
    const v = opposedVerdict(passed[i], hits, over)
    if (v.refused) {
      at.add(i)
      out.refused.push(`${label} not applied: ${v.refused}`)
      continue
    }
    out.overrides.push(`${label} applied over ${v.over}: newer`)
    if (over.length) out.freed.push(...ids)
    if (over.length) out.over.set(i, over.map(s => s.id))
  }
  return { at, ...out }
}

/** ` (<id>)` for a label; '' for no id or one with a control character. @param {string | undefined} id @returns {string} */
function idTail(id) {
  return id && !hasControlChar(id) ? ` (${id})` : ''
}

/**
 * One passed record against the records opposing it: why it is held back (a successor not older first,
 * then an inactive copy), or, when it is later than all of them, what it is applied over.
 * @param {unknown} x @param {InactiveRecord[]} hits @param {Successor[]} over @returns {{ refused?: string, over?: string }}
 */
function opposedVerdict(x, hits, over) {
  const o = /** @type {Record<string, unknown>} */ (x)
  const date = decisionText(o['when']) || decisionText(o['date'])
  const held = over.map(s => ({ s, why: notLaterWhy(date, s) })).find(h => h.why)
  if (held) return { refused: `held by ${held.s.id} (active, ${held.s.date || 'undated'}) (${held.why})` }
  const stop = hits.map(e => ({ e, why: notLaterWhy(date, e) })).find(h => h.why)
  if (stop) return { refused: `${stop.e.status} in memory (${stop.why})` }
  const last = hits.length ? [hits.reduce((m, e) => (notLaterWhy(e.date, m) ? m : e))].map(e => `a ${e.status} record of ${e.date}`) : []
  return { over: [...last, ...over.map(s => `${s.id} (active, ${s.date})`)].join(' and ') }
}

/** The record without its `supersedes:`/`answers:` links to any of `freed`; itself when it has none. @param {unknown} x @param {Set<string>} freed @returns {unknown} */
function withoutLinksTo(x, freed) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return x
  const o = /** @type {Record<string, unknown>} */ (x)
  if (!Array.isArray(o['links'])) return x
  const links = o['links'].filter(l => !supersededIds([l]).some(id => freed.has(id)))
  return links.length === o['links'].length ? x : { ...o, links }
}

/** The record with `overrides` naming the successors it overrides; itself when none. @param {unknown} x @param {string[] | undefined} ids @returns {unknown} */
function withOverrides(x, ids) {
  return ids?.length && x && typeof x === 'object' && !Array.isArray(x) ? { ...x, overrides: ids } : x
}

/**
 * The source with the launcher's part: nothing when it passed no record.
 * @param {MemorySource} m @param {number} passed @param {number} added @returns {MemorySource}
 */
function withPassed(m, passed, added) {
  return passed ? { ...m, passed, added } : m
}

const DERIVED_NAMED_MAX = 3

const DERIVED_TITLE_MAX = 40

/**
 * The source with how many of the applied records had their id derived, the first few named; unchanged when none.
 * @param {MemorySource} m @param {Array<{ id?: string, title?: string, derived?: boolean }>} applied @returns {MemorySource}
 */
function withDerived(m, applied) {
  const derived = applied.filter(d => d.derived)
  /** @param {string} t */
  const cut = t => (t.length > DERIVED_TITLE_MAX ? `${t.slice(0, DERIVED_TITLE_MAX)}…` : t)
  const derivedNamed = derived.slice(0, DERIVED_NAMED_MAX).map(d => `${d.id ?? ''} (${cut(d.title ?? '')})`)
  return derived.length ? { ...m, derived: derived.length, derivedNamed } : m
}

/** The derived ids' tail of the memory line; '' when none was derived. @param {MemorySource} m @returns {string} */
function derivedTail(m) {
  if (!m.derived) return ''
  const named = m.derivedNamed ?? []
  const more = m.derived - named.length
  return `; id derived for ${m.derived} record(s)${named.length ? `: ${named.join(', ')}` : ''}${more > 0 && named.length ? ` and ${more} more` : ''}`
}

/**
 * The list with the id derived for each record that carries none (derivedRecordId), so the reviews it is
 * forwarded to receive records with their id; anything else unchanged. @param {unknown} list @returns {unknown}
 */
function withDerivedIds(list) {
  if (!Array.isArray(list)) return list
  return list.map(x => {
    const id = x && typeof x === 'object' && !Array.isArray(x) ? derivedRecordId(/** @type {Record<string, unknown>} */ (x)) : ''
    return id ? { .../** @type {object} */ (x), id } : x
  })
}

/**
 * A merged list (its first `recalledLen` records the recall's, the rest the launcher's) read ONCE by
 * `parse`, so one cap holds across both parts; each refusal names its part (`passedAt` maps a passed
 * record back to its index in the launcher's list). The applied records split by part: a recalled id is
 * one a readable recalled record holds, and `passed` counts the applied rest — the launcher's records
 * new to this run, after the cap (realm @nick/craft, node #218).
 * @template {{ id: string, kind?: string, derived?: boolean }} D
 * @param {unknown[]} list @param {number} recalledLen @param {ParseDecisions<D>} parse @param {number[]} [passedAt]
 * @returns {{ prior: { decisions: D[], refused: string[] }, recalled: D[], passed: number }}
 */
function parseMerged(list, recalledLen, parse, passedAt = []) {
  /** @param {number} i */
  const labelOf = i => (i < recalledLen ? `recalled decision #${i}` : `passed decision #${passedAt[i - recalledLen] ?? i - recalledLen}`)
  const prior = parse(list, labelOf)
  const held = new Set(list.slice(0, recalledLen).flatMap(x => parse([x]).decisions.map(d => d.id)))
  const recalled = prior.decisions.filter(d => held.has(d.id))
  return { prior, recalled, passed: prior.decisions.length - recalled.length }
}

/**
 * The recall's records merged with the launcher's list (mergeById, a recalled record `parse` reads
 * whatever its status kept on an id clash) and read once (parseMerged); `parts` is how the merged list splits —
 * what a launching audit forwards as `_memoryParts`, so it adds up to the list. A passed record an
 * `inactive` record names, or an active recalled successor supersedes or answers, is left out of the
 * merge and named in `blocked`, or, dated later than all of them, kept and named in `overrides`, the
 * successors' links to it dropped from the merged list (blockedPassed) — checked only once the recall's own records did not already
 * hold it: a copy of a record the recall returned is the same decision, dropped silently.
 * @template {{ id: string, kind?: string, derived?: boolean }} D
 * @param {unknown[]} recalled @param {unknown[]} passed @param {ParseDecisions<D>} parse @param {InactiveRecord[]} [inactive]
 * @returns {{ merged: unknown[], parts: { recalled: number, passed: number }, read: { prior: { decisions: D[], refused: string[] }, recalled: D[], passed: number }, blocked: string[], overrides: string[] }}
 */
function mergeAndRead(recalled, passed, parse, inactive = []) {
  /** @param {unknown} x */
  const wellFormed = x => parse([x && typeof x === 'object' && !Array.isArray(x) ? { ...x, status: null } : x]).decisions.length > 0
  const fresh = mergeById(recalled, passed, wellFormed).addedAt
  const block = blockedPassed(passed, inactive, fresh, successorRecords(recalled, x => parse([x]).decisions.length > 0))
  const addedAt = fresh.filter(i => !block.at.has(i))
  const freed = new Set(block.freed)
  const merged = [...(freed.size ? recalled.map(x => withoutLinksTo(x, freed)) : recalled), ...addedAt.map(i => withOverrides(passed[i], block.over.get(i)))]
  return { merged, parts: { recalled: recalled.length, passed: addedAt.length }, read: parseMerged(merged, recalled.length, parse, addedAt), blocked: block.refused, overrides: block.overrides }
}

/** `N decision(s) and M open question(s)` of a source. @param {MemorySource} m @returns {string} */
function countedRecords(m) {
  const q = m.questions || 0
  return `${m.count - q} decision(s)${q ? ` and ${q} open question(s)` : ''}`
}

/**
 * The line of a review the launching audit recalled for: what it applied — split into the audit's
 * recall and its launcher's records when the audit said how (`_memoryParts`) — or why that recall found
 * none (and what the audit's own launcher passed). @param {MemorySource} m @returns {string}
 */
function launcherLine(m) {
  const parts = m.passed ? ` — ${m.count - (m.added ?? 0)} recalled, ${m.added ?? 0} of the ${m.passed} passed by its launcher` : ''
  if (!m.why) return `memory: recalled by the launching audit — ${m.count ? `applied ${countedRecords(m)}${parts}` : `none${parts}`}`
  return `memory: recalled by the launching audit — none (${m.why})${m.count ? `; applied ${m.count} passed by its launcher` : ''}`
}

/**
 * One line, both parts: what the recall gave, then what the launcher added.
 * @param {MemorySource} m @param {boolean} [forwarded] the list went unparsed to nested reviews (rust-audit):
 * the count is what recall returned, not what was accepted @returns {string}
 */
function memoryLine(m, forwarded = false) {
  return `${sourceLine(m, forwarded)}${derivedTail(m)}`
}

/** memoryLine without the derived ids' tail. @param {MemorySource} m @param {boolean} forwarded @returns {string} */
function sourceLine(m, forwarded) {
  if (m.source === 'launcher') return launcherLine(m)
  const plus = m.passed ? `; plus ${m.passed} passed by the launcher${m.source === 'recalled' ? ` (${m.added ?? m.passed} new)` : ''}` : ''
  if (m.source !== 'recalled') return `memory: none — ${m.why}${plus}`
  return forwarded
    ? `memory: returned ${countedRecords(m)} from ${m.why}${plus}; each nested review reports how many it applied`
    : `memory: recalled ${countedRecords(m)} from ${m.why}${plus}`
}

/** The report section naming the source. @param {MemorySource} m @param {boolean} [forwarded] @returns {string} */
function memorySection(m, forwarded = false) {
  return `\n\n## Memory\n- ${memoryLine(m, forwarded)}\n`
}

/**
 * Runs the one recall agent through `ask` (the engine's agent call, schema MEMORY_RECALL_SCHEMA). A
 * refused dispatch (the budget wall) is named and applies nothing: the run meets the same wall on its
 * next dispatch, as it would have without a recall.
 * @param {(prompt: string) => Promise<unknown>} ask @param {string[]} paths @param {string} base
 * @returns {Promise<{ decisions: unknown[], memory: MemorySource, inactive: InactiveRecord[] }>}
 */
async function recallDecisions(ask, paths, base) {
  let raw
  try {
    raw = await ask(memoryRecallPrompt(paths, base))
  } catch (e) {
    const msg = recallText(e instanceof Error ? e.message : String(e))
    return { decisions: [], inactive: [], memory: { source: 'none', count: 0, why: `the recall agent did not run (${msg}) — nothing recalled applied; findings are raised normally` } }
  }
  return readMemoryRecall(raw, Math.max(0, paths.length - RECALL_PATHS_MAX))
}
/** @type {unknown} */
const passedDecisions = A['priorDecisions']
const passedList = Array.isArray(passedDecisions) ? /** @type {unknown[]} */ (passedDecisions) : []
const passedRead = parsePriorDecisions(passedList).decisions
const passedAccepted = passedRead.length
const recalledByLauncher = A['_recalled'] === true
/** @type {unknown} */
let nestedPriorDecisions = withDerivedIds(passedDecisions)
let memory = withDerived(initialMemory(passedAccepted, recalledByLauncher, A['_memory']), passedRead)
let nestedMemoryNote = recalledByLauncher ? recallText(A['_memory']) : ''
/** @type {unknown} */
let nestedMemoryParts = recalledByLauncher ? A['_memoryParts'] : undefined
function nestedReviewArgs() {
  return {
    ...(craftRootArg ? { craftRoot: craftRootArg } : {}),
    ...(nestedPriorDecisions != null ? { priorDecisions: nestedPriorDecisions } : {}),
    ...(memory.source !== 'none' || nestedMemoryNote ? { _recalled: true } : {}),
    ...(nestedMemoryNote ? { _memory: nestedMemoryNote } : {}),
    ...(nestedMemoryParts != null ? { _memoryParts: nestedMemoryParts } : {}),
  }
}

const CRATE_ITEM = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'path'],
  properties: {
    name: { type: 'string', description: 'crate (package) name' },
    path: { type: 'string', description: "crate directory (its manifest dir), RELATIVE to the repo root — never the absolute `manifest_path` cargo prints, and never a leading `/`" },
  },
}

const EDGE_ITEM = {
  type: 'object',
  additionalProperties: false,
  required: ['from', 'to'],
  properties: {
    from: { type: 'string', description: 'caller crate name (depends on `to`)' },
    to: { type: 'string', description: 'callee crate name' },
  },
}

const SCOUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['hasDiff', 'hasUnsafe', 'baseRef', 'repoRoot', 'crates', 'changedCrates', 'edges', 'notes'],
  properties: {
    hasDiff: { type: 'boolean', description: 'true if any .rs files differ vs the base ref (committed or uncommitted)' },
    hasUnsafe: { type: 'boolean', description: 'true if the workspace contains any `unsafe` block or impl' },
    baseRef: { type: 'string', description: 'the git ref the diff was computed against, or empty if none resolved' },
    repoRoot: { type: 'string', description: 'absolute path of the repository root (`git rev-parse --show-toplevel`), empty if it cannot be resolved — used ONLY to relativize a crate path that came back absolute' },
    crates: { type: 'array', items: CRATE_ITEM, description: 'workspace members; empty if cargo metadata is unavailable' },
    changedCrates: { type: 'array', items: CRATE_ITEM, description: 'subset of crates with a changed .rs file vs the base; empty if no base / no changes' },
    edges: { type: 'array', items: EDGE_ITEM, description: 'intra-workspace dependency edges; empty if cargo metadata is unavailable' },
    notes: { type: 'string', description: 'one line on what was detected' },
  },
}

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['dimension', 'verdict', 'summary', 'findings', 'evidence'],
  properties: {
    dimension: { type: 'string', description: 'dimension label, e.g. review:<crate> | contract:<from>→<to> | architecture | security | miri | crate-decomposition | semver | build-matrix | deps | unused-crates | tests-cov' },
    verdict: {
      type: 'string',
      enum: ['Approve', 'Warning', 'Block', 'Healthy', 'Concerns', 'At-risk', 'Clean', 'UB-found', 'INCOMPLETE (not run)'],
      description: 'Approve/Warning/Block, Healthy/Concerns/At-risk, or Clean/UB-found — use one of these words exactly. Use "INCOMPLETE (not run)" when the tooling this dimension depends on was absent, so nothing was actually checked: a dimension that could not run is NOT an Approve.',
    },
    summary: { type: 'string', description: 'one-paragraph bottom line' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'title', 'location', 'detail'],
        properties: {
          severity: { type: 'string', description: 'Critical | High | Medium | Low | Info' },
          title: { type: 'string' },
          location: { type: 'string', description: 'file:line or crate/module, empty if not applicable' },
          detail: { type: 'string', description: 'what is wrong and the direction of the fix' },
        },
      },
    },
    evidence: { type: 'string', description: 'Evidence: <the concrete commands run / tools used / files read this pass — never invented>. A passing verdict with an empty evidence field is treated as INCOMPLETE, not trusted.' },
  },
}

const UNUSED_VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['confirmedUnused', 'evidence', 'removal'],
  properties: {
    confirmedUnused: { type: 'boolean', description: 'true ONLY if genuinely unused after trying to refute; default false when uncertain' },
    evidence: { type: 'string', description: 'what was checked — use sites, cfg/feature gates, macros, re-exports, build.rs, dev/bench/example usage, bin/published status' },
    removal: { type: 'string', description: 'concrete removal direction if confirmed unused; empty otherwise' },
  },
}

/** @typedef {{ name: string, path: string }} CrateItem */
/** @typedef {{ from: string, to: string }} EdgeItem */
/**
 * @typedef {{ hasDiff: boolean, hasUnsafe: boolean, baseRef: string, repoRoot: string, crates: CrateItem[],
 *   changedCrates: CrateItem[], edges: EdgeItem[], notes: string }} ScoutResult
 */
/** @typedef {{ severity: string, title: string, location: string, detail: string }} Finding */
/** @typedef {{ dimension: string, verdict: string, summary: string, findings: Finding[], evidence: string }} FindingsResult */
/** @typedef {{ confirmedUnused: boolean, evidence: string, removal: string }} UnusedVerdict */
/**
 * @typedef {{ candidates: number, confirmed: number, refuted: number, died: number, judged: number,
 *   refuteRate: number | null }} VerificationStats
 * @typedef {{ dimension: string, verdict: string, summary: string, findings: Finding[], evidence?: string,
 *   _verification?: VerificationStats, _priorDecisions?: string }} DimResult
 */

const CRAFT_VERSION = '0.24.4' // x-release-please-version

/** @type {Severity[]} */
const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Info']

/**
 * @param {unknown} findings
 * @returns {Record<Severity, number>}
 */
function countBySeverity(findings) {
  const by = { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 }
  for (const f of (Array.isArray(findings) ? findings : [])) {
    if (f && Object.prototype.hasOwnProperty.call(by, f.severity)) by[/** @type {Severity} */ (f.severity)] += 1
  }
  return by
}

/**
 * @param {unknown} findings
 * @returns {{ total: number, bySeverity: Record<Severity, number> }}
 */
function summarizeFindings(findings) {
  const bySeverity = countBySeverity(findings)
  return { total: SEVERITIES.reduce((n, s) => n + bySeverity[s], 0), bySeverity }
}

/**
 * @param {unknown} verdicts
 * @returns {string}
 */
function worstVerdict(verdicts) {
  const vs = (Array.isArray(verdicts) ? verdicts : []).map(v => String(v || ''))
  if (!vs.length) return 'INCOMPLETE (no verdicts)'
  if (vs.some(v => /Block|At-risk|UB-found/i.test(v))) return 'Block'
  if (vs.some(v => /Warning|Concerns/i.test(v))) return 'Warning'
  if (vs.some(v => /INCOMPLETE/i.test(v) || !GREEN_VERDICT.test(v))) return 'Warning'
  return 'Approve'
}

/**
 * @param {{ engine: string, repo: string, craftVersion: string, outputTokens: number, via?: string }} o
 *   `via`: the parent workflow that dispatched this run, '' when it was not nested
 */
function repoRefusal({ engine, repo, craftVersion, outputTokens, via = '' }) {
  return {
    record: {
      schemaVersion: 1, runtime: 'claude-code', craftVersion, kind: 'workflow', name: engine,
      nested: !!via, via: via || null,
      verdict: 'INCOMPLETE (repo not supported)', findings: summarizeFindings([]), dimensions: [], verification: null,
      notRun: ['`repo` argument refused — this engine reviews only the session\'s own checkout'],
      outputTokens,
    },
    report: [
      `## Verdict`,
      `⚠️ INCOMPLETE — \`repo=${repo}\` was given, but \`${engine}\` does not support reviewing a repository other than the one this session runs in: its agents would read THIS checkout and report a normal-looking verdict for the wrong code. Nothing ran.`,
      ``,
      `Either run \`craft:review\` with \`repo=\` (that engine threads a working-directory directive through its prompts), or start a session inside that repository and run \`${engine}\` there.`,
    ].join('\n'),
  }
}

/**
 * @template C, V
 * @param {C} c candidate (model output)
 * @param {V} v verifier verdict (model output); null or undefined when the verifier died
 * @returns {{ c: C, v: NonNullable<V> } | null}
 */
function wrapVerdict(c, v) {
  return v == null ? null : { c, v }
}

const VERIFY_MIN_JUDGED = 0.5

/**
 * @typedef {{ candidates: number, judged: number, confirmed: number, refuted: number, died: number }} VerifyTally
 * @typedef {{ title: string, location?: string, detail?: string }} Candidate  a detector's finding, as the engine's schema shapes it
 * @typedef {{ confirmedUnused?: unknown, evidence?: unknown, removal?: unknown }} UnusedVerdictShape  a verifier's answer (model output), fields unchecked
 */
/**
 * @template C
 * @template {UnusedVerdictShape} V
 * @param {C[]} candidates
 * @param {Array<{ c: C, v: V } | null>} verdicts
 */
function tallyVerification(candidates, verdicts) {
  const list = Array.isArray(candidates) ? candidates : []
  /** @type {Array<{ c: C, v: V }>} */
  const alive = []
  for (const x of (Array.isArray(verdicts) ? verdicts : [])) if (x) alive.push(x)
  const confirmedItems = alive.filter(x => x && x.v && x.v.confirmedUnused)
  const judged = alive.length
  const died = list.length - judged
  return {
    candidates: list.length,
    judged,
    judgedItems: alive,
    died: died > 0 ? died : 0,
    confirmedItems,
    confirmed: confirmedItems.length,
    refuted: judged - confirmedItems.length,
    refuteRate: judged ? Math.round(((judged - confirmedItems.length) / judged) * 100) / 100 : null,
  }
}

/** @param {{ candidates: number, judged: number }} t */
function verificationIncomplete(t) {
  return t.candidates > 0 && t.judged < Math.ceil(t.candidates * VERIFY_MIN_JUDGED)
}

/**
 * @template {Candidate} C
 * @template {UnusedVerdictShape} V
 * @param {C[]} candidates
 * @param {Array<{ c: C, v: V } | null>} verdicts
 */
function unusedCratesResult(candidates, verdicts) {
  const t = tallyVerification(candidates, verdicts)
  const _verification = { candidates: t.candidates, confirmed: t.confirmed, refuted: t.refuted, died: t.died, judged: t.judged, refuteRate: t.refuteRate }
  const diedNote = t.died ? ` ${t.died} verifier(s) died — those candidates are UNVERIFIED, neither confirmed nor cleared.` : ''
  const confirmed = t.confirmedItems.map(x => ({
    severity: 'Medium',
    title: x.c.title,
    location: x.c.location || '',
    detail: `${x.v.evidence || ''}${x.v.removal ? `\nRemove: ${x.v.removal}` : ''}`.trim() || (x.c.detail || ''),
  }))
  if (verificationIncomplete(t)) {
    const unjudged = (Array.isArray(candidates) ? candidates : [])
      .filter(c => !t.judgedItems.some(x => x.c === c))
      .map(c => ({ severity: 'Info', title: `unverified: ${c.title}`, location: c.location || '', detail: `${c.detail || ''}\nVerification did not run for this candidate — it is neither confirmed unused nor cleared.`.trim() }))
    return {
      dimension: 'unused-crates',
      verdict: 'INCOMPLETE (not run)',
      summary: t.judged
        ? `${t.candidates} candidate(s) flagged; ${t.judged} judged (${t.confirmed} verified unused, ${t.refuted} refuted), ${t.died} verifier(s) died. ${t.candidates - t.judged} candidate(s) are UNVERIFIED — neither confirmed nor cleared.`
        : `${t.candidates} candidate(s) flagged, but every verifier failed to return — none was confirmed OR refuted. The unused-crate surface is UNVERIFIED, not clean.`,
      findings: confirmed.concat(unjudged),
      evidence: unusedEvidence(t),
      _verification,
    }
  }
  return {
    dimension: 'unused-crates',
    verdict: confirmed.length ? 'Warning' : 'Approve',
    summary: `${t.candidates} candidate(s) flagged; ${t.confirmed} verified unused after trying to refute each; ${t.refuted} refuted (kept).${diedNote}`,
    findings: confirmed.length ? confirmed : [{ severity: 'Info', title: 'No verified unused crates', location: '', detail: `${t.candidates} candidate(s) flagged, ${t.refuted} refuted by verification.${diedNote}` }],
    evidence: unusedEvidence(t),
    _verification,
  }
}

/** @param {VerifyTally} t */
function unusedEvidence(t) {
  return `Evidence: ran the orphan/unused-dep detectors and verified each candidate — ${t.candidates} flagged, ${t.judged} judged (${t.confirmed} confirmed unused, ${t.refuted} refuted), ${t.died} verifier(s) died.`
}

/** @internal */
const EVIDENCE_MARKER = 'Evidence:'

const EVIDENCE_LINE = /^evidence\s*:/i

const GREEN_VERDICT = /^(approve[ds]?|healthy|clean|pass(ed|ing)?|ok(ay)?|fine|good|green|no ub( (detected|found))?|no (issues|findings|problems|defects)( (detected|found))?|none( found)?|nothing (found|to report)|all (clear|good))[\s.!—–-]*$/i

/** @param {unknown} text  free-form agent text; null/undefined read as empty
 * @returns {boolean} */
function hasEvidence(text) {
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '')
    const i = line.search(/[^ \t>*_`#-]/)                         // first non-decoration column (VERDICT_LINE's class)
    if (i < 0) continue                                           // decoration/whitespace only — no marker
    const m = EVIDENCE_LINE.exec(line.slice(i))                   // marker at that column, case- and stray-space tolerant
    if (!m) continue                                              // line does not begin with the marker
    if (/[^ \t>*_`#-]/.test(line.slice(i + m[0].length))) return true  // real content follows it
  }
  return false
}

/** @template {{ verdict?: unknown, evidence?: unknown, summary?: unknown }} R
 * @param {R | null | undefined} r  a dimension result as returned by an agent
 * @returns {R | null | undefined} */
function demoteUnsupportedGreen(r) {
  if (!r || !GREEN_VERDICT.test(String(r.verdict ?? ''))) return r
  if (hasEvidence(r.evidence || r.summary)) return r
  return { ...r, verdict: `INCOMPLETE (no evidence — claimed ${r.verdict})` }
}

/** @param {unknown} v model output */
function normalizeDimensionVerdict(v) {
  const t = String(v == null ? '' : v).trim()
  if (!t) return t
  if (/INCOMPLETE/i.test(t)) return t
  if (GREEN_VERDICT.test(t)) return 'Approve'
  if (/\b(block(ing|ed)?|at[- ]risk|ub[- ]found|found ub|fail(ed|ure|ing)?|critical)\b/i.test(t)) return 'Block'
  if (/\b(warn(ing)?s?|concerns?|caution)\b/i.test(t)) return 'Warning'
  return t
}

/**
 * @param {string} worst
 * @param {unknown[]} notRun
 */
function auditVerdict(worst, notRun) {
  if (!notRun.length || /INCOMPLETE/i.test(worst)) return worst
  return `${worst} (INCOMPLETE)`
}

/**
 * @param {Record<string, unknown>} obj
 * @returns {Record<string, unknown>}
 */
function stripInternal(obj) {
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const k of Object.keys(obj)) if (!k.startsWith('_')) out[k] = obj[k]
  return out
}
const LOGRUN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: {
    ok: { type: 'boolean', description: 'true only if the script ran and printed no craft-log-run FAILED line' },
    error: { type: 'string', description: 'when ok is false, the failing line verbatim; when ok is true AND the script printed a craft-log-run WARNING line, that line verbatim; empty otherwise' },
  },
}

/** @param {unknown} s */
function shq(s) { return `'${String(s ?? '').replace(/'/g, `'\\''`)}'` }

/**
 * @param {string | undefined} craftRoot
 * @param {string} [version]
 * @param {string} [repo]
 */
function loggerPrelude(craftRoot, version = '', repo = '') {
  const preamble = `CRAFT_REPO="$(cd ${shq(repo || '.')} 2>/dev/null && pwd -P)" || CRAFT_REPO=""
craft_usable() {   # a line that is exactly '}' at column 0 would end the extracted region early
  case "$1" in /*) ;; *) return 1 ;; esac
  [ -f "$1" ] || return 1
  [ -n "$CRAFT_REPO" ] || return 1   # belt to the braces below; see the note in the comment above
  # A repo of "/" contains everything, so nothing can be outside it. The pattern below cannot say
  # that: "$CRAFT_REPO"/* becomes //* and matches no ordinary path, so every candidate reads as
  # outside and the guard inverts into an allow-all. Degenerate input, but the whole point of this
  # predicate is that it fails closed.
  [ "$CRAFT_REPO" = "/" ] && return 1
  CRAFT_REAL="$1"
  CRAFT_HOPS=0
  while [ -L "$CRAFT_REAL" ]; do
    [ "$CRAFT_HOPS" -lt 16 ] || return 1
    CRAFT_LINK="$(readlink "$CRAFT_REAL")"
    case "$CRAFT_LINK" in
      /*) CRAFT_REAL="$CRAFT_LINK" ;;
      *) CRAFT_REAL="$(dirname "$CRAFT_REAL")/$CRAFT_LINK" ;;
    esac
    CRAFT_HOPS=$((CRAFT_HOPS + 1))
  done
  CRAFT_DIR="$(cd "$(dirname "$CRAFT_REAL")" 2>/dev/null && pwd -P)" || return 1
  [ -n "$CRAFT_DIR" ] || return 1
  CRAFT_REAL="$CRAFT_DIR/$(basename "$CRAFT_REAL")"
  case "$CRAFT_REAL" in
    "$CRAFT_REPO"/*|"$CRAFT_REPO") return 1 ;;
  esac
  return 0
 }
CRAFT_LOGGER=""
`
  /** @param {string} expr */
  const tryCandidate = expr => `if [ -z "\${CRAFT_LOGGER:-}" ]; then
  CRAFT_TRY=${expr}
  craft_usable "$CRAFT_TRY" && CRAFT_LOGGER="$CRAFT_REAL"
fi
`
  const explicit = craftRoot ? tryCandidate(`${shq(craftRoot)}"/lib/craft-log-run.mjs"`) : ''
  const fromEnv = tryCandidate('"${CLAUDE_PLUGIN_ROOT:-}/lib/craft-log-run.mjs"')
  const installed = version
    ? tryCandidate(`"\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/craft/craft/"${shq(version)}"/lib/craft-log-run.mjs"`)
    : ''
  return `${preamble}${explicit}${fromEnv}${installed}[ -n "\${CRAFT_LOGGER:-}" ] || { echo "craft-log-run FAILED: no usable logger — no absolute craftRoot outside the reviewed repo, no CLAUDE_PLUGIN_ROOT, and no installed copy of "${version ? shq(version) : "'this version'"}" under the plugin cache; refusing to resolve against the reviewed repository"; exit 1; }
`
}

/** @param {unknown} payload @returns {string} */
function payloadVersion(payload) {
  return String((payload && typeof payload === 'object' ? /** @type {{ craftVersion?: unknown }} */ (payload).craftVersion : undefined) ?? '')
}

/** @param {unknown} payload @returns {string} */
function engineRevisionFlag(payload) {
  const rev = payload && typeof payload === 'object' ? /** @type {{ workflowEngineRevision?: unknown }} */ (payload).workflowEngineRevision : undefined
  return Number.isInteger(rev) ? `--engine-revision ${rev} ` : ''
}

/** @param {string} dir @param {boolean} rejoin @returns {string} */
function runDirFlags(dir, rejoin) {
  return `${dir ? `--dir ${shq(dir)} ` : ''}${rejoin ? '--rejoin ' : ''}\${CLAUDE_CODE_SESSION_ID:+--session "$CLAUDE_CODE_SESSION_ID"} `
}

/** @param {{ record?: unknown, craftRoot?: string, repo?: string, command?: string, dir?: string, rejoin?: boolean }} [opts] */
function logRunPrompt({ record, craftRoot = '', repo = '', command = 'write', dir = '', rejoin = false } = {}) {
  const version = payloadVersion(record)
  const flags = runDirFlags(dir, rejoin)
  return `You are the craft observability logger. Persist ONE run record. This is mechanical IO — do not analyze, summarise, reformat or "clean up" any part of it.

Run exactly this:

\`\`\`
${loggerPrelude(craftRoot, version, repo)}CRAFT_REC="$(mktemp "\${TMPDIR:-/tmp}/craft-rec.XXXXXX")"
cat > "$CRAFT_REC" <<'CRAFT_RECORD_EOF'
…RECORD below, byte for byte…
CRAFT_RECORD_EOF
cd ${shq(repo || '.')} && node "$CRAFT_LOGGER" ${command} ${engineRevisionFlag(record)}${flags}--project "$PWD" < "$CRAFT_REC"; CRAFT_RC=$?; rm -f "$CRAFT_REC"; exit $CRAFT_RC
\`\`\`

The script computes every field (ts, project, commit, dirty, engineRevision, craftCommit, and — reading the working copy with git — branch and head, whose values in the record below are only a fallback for what git cannot resolve), names the file, appends the index line and verifies the readback. You compute NONE of that. In particular: do NOT \`mkdir\` the store, do NOT run \`date\`, \`pwd\` or \`git\` yourself, and do NOT append to index.jsonl by hand.

COPY THE RECORD VERBATIM into the quoted heredoc — it can be hundreds of KB (findings, ledger, dimensions), and re-emitting it from memory silently drops the big arrays. That is exactly how a completed review once persisted \`findings: 111\` with \`dimensions: []\` and no \`verification\`, destroying the per-lens telemetry the whole store exists for.

If the script prints a line starting \`craft-log-run FAILED\`, or the command itself fails (for example the logger path does not exist), return {"ok": false, "error": "<that line, or the shell error, verbatim>"} and stop — do NOT fall back to writing the file by hand. If it succeeded, return {"ok": true} — and if it ALSO printed a line starting \`craft-log-run WARNING\`, return {"ok": true, "error": "<that line verbatim>"}: the record landed, but something about the run directory did not, and the engine has to be able to say so. Best-effort either way: never error the run over this.

RECORD:
${JSON.stringify(record, null, 2)}`
}

/**
 * @param {unknown} record
 * @param {{ phase?: string }} [opts]
 * @returns {{ label: string, phase: string, schema: typeof LOGRUN_SCHEMA, model: 'sonnet' | 'haiku', effort: 'low' }}
 */
function logRunDispatch(record, { phase = '' } = {}) {
  const payloadKB = JSON.stringify(record).length / 1024
  const big = payloadKB > 24
  return {
    label: `log-run${big ? ` (${Math.round(payloadKB)}KB)` : ''}`,
    phase,
    schema: LOGRUN_SCHEMA,
    model: big ? 'sonnet' : 'haiku',
    effort: 'low',
  }
}

/**
 * @param {unknown} res harness result of the logger agent (model output), or a quiet call's `{ __threw }`
 * @returns {{ ok: boolean, reason: string }}
 */
function logRunOutcome(res) {
  const r = res && typeof res === 'object' ? /** @type {{ ok?: unknown, error?: unknown, __threw?: unknown }} */ (res) : null
  if (r && r.ok === true) return { ok: true, reason: String((r.error || '')).trim() }
  return { ok: false, reason: String((r && (r.__threw || r.error)) || 'the logger agent returned no result') }
}

/**
 * @template P, O, R
 * @param {(prompt: P, opts: O) => Promise<R>} call a harness agent callback
 * @returns {(prompt: P, opts: O) => Promise<R | { __threw: string }>}
 */
function quietly(call) {
  return async (prompt, opts) => {
    try {
      return await call(prompt, opts)
    } catch (e) {
      return { __threw: String((e && /** @type {{ message?: unknown }} */ (e).message) || e) }
    }
  }
}

/**
 * @template O
 * @param {object} o
 * @param {(prompt: string, opts: ReturnType<typeof logRunDispatch>) => Promise<O>} o.call  a `quietly`-wrapped agent callback
 * @param {string} o.phase
 * @param {() => { craftRoot?: string, repo?: string, command?: string, dir?: string, rejoin?: boolean }} o.target
 * @param {(what: string, why: string, landed: boolean) => void} o.noteLoss
 * @param {(record: Record<string, unknown>) => Record<string, unknown>} [o.prepare]
 * @returns {(record: Record<string, unknown>) => Promise<void>}
 */
function makeRunLogger({ call, phase, target, noteLoss, prepare = record => record }) {
  return async recordIn => {
    const record = prepare(recordIn)
    const landed = logRunOutcome(await call(logRunPrompt({ ...target(), record }), logRunDispatch(record, { phase })))
    if (!landed.ok) noteLoss('the run record', landed.reason, false)
    else if (landed.reason) noteLoss('the run directory (the record itself landed)', landed.reason, true)
  }
}

/**
 * @param {string[]} lost
 * @param {(line: string) => void} say
 * @returns {(what: string, why: string, landed: boolean) => void}
 */
function telemetryLossNoter(lost, say) {
  return (what, why, landed) => {
    lost.push(`${what} — ${why}`)
    say(landed ? `⚠️ telemetry: ${why}` : `⚠️ telemetry lost: ${what} — ${why}`)
  }
}
/** @param {unknown} lost */
function telemetryLostSection(lost) {
  const lines = /** @type {unknown[]} */ (Array.isArray(lost) ? lost : []).filter(l => String(l ?? '').trim())
  if (!lines.length) return ''
  const landed = lines.filter(l => /^the run directory \(the record itself landed\)/.test(String(l)))
  const unconfirmed = lines.length - landed.length
  const head = unconfirmed
    ? `${unconfirmed} record write(s)/read(s) for this run could not be confirmed, so the run store may be missing or incomplete for it. Read the verdict below — not the store — for what this run actually did.`
    : `This run's record is in the store, but ${landed.length} run director${landed.length === 1 ? 'y' : 'ies'} could not be folded into it, so what those held is not there. Read the verdict below for what this run actually did.`
  return [
    unconfirmed ? `## ⚠️ Telemetry lost` : `## ⚠️ Telemetry incomplete`,
    head,
    ...lines.map(l => `- ${String(l).replace(/[\r\n]+/g, ' ').slice(0, 300)}`),
    ``,
    ``,
  ].join('\n')
}

/** @type {string[]} */
const telemetryLost = []
const logRun = makeRunLogger({
  call: quietly(agent), phase: 'Synthesize', target: () => ({ craftRoot: craftRootArg }),
  noteLoss: telemetryLossNoter(telemetryLost, log),
})

/** @param {unknown} msg @param {string} [agent] */
function isAgentTypeMissing(msg, agent) {
  const m = String(msg ?? '')
  return /not found/i.test(m) && (/agent type/i.test(m) || (!!agent && m.includes(agent)))
}

/**
 * @param {{ agent: string, what: string, error?: string }[]} missing
 * @param {{ agent: string, count: number, what: string, error?: string }[]} emptied
 * @returns {string}
 */
function agentUnavailableSection(missing, emptied) {
  const hard = Array.isArray(missing) ? missing : []
  const soft = (Array.isArray(emptied) ? emptied : []).filter(x => x && x.count > 0)
  if (!hard.length && !soft.length) return ''
  /** @param {unknown} e */
  const quote = e => String(e).replace(/\s+/g, ' ').trim().slice(0, 160)
  const lines = [
    ...hard.map(x => `- \`${x.agent}\` is not registered in this session, so ${x.what} went to the generic subagent, without that agent's rubric — this run is weaker than a normal one, not broken.${x.error ? ` (${quote(x.error)})` : ''}`),
    ...soft.map(x => x.error
      ? `- \`${x.agent}\` failed with "${quote(x.error)}" on ${x.count} ${x.what}, which were re-run on the generic subagent, without its rubric (an unregistered agent in wording this engine does not recognise, or a missing model or tool).`
      : `- \`${x.agent}\` returned nothing for ${x.count} ${x.what}, which were re-run on the generic subagent, without its rubric (an unregistered agent on some runtimes, or a transient failure).`),
  ]
  const fix = hard.length ? 'Enable the plugin in this project (`/plugin install craft@craft`, project or local scope) and re-run to use it.\n' : ''
  return `## ⚠️ Reviewer agent unavailable\n${lines.join('\n')}\n${fix}\n`
}

/**
 * @param {Iterable<string>} missing
 * @param {{ agent: string, count: number }[]} fallbacks
 * @returns {{ agentUnavailable: string[], agentFallbacks: Record<string, number> }}
 */
function agentUnavailableRecord(missing, fallbacks) {
  /** @type {Record<string, number>} */
  const agentFallbacks = {}
  for (const x of fallbacks) if (x.count > 0) agentFallbacks[x.agent] = (agentFallbacks[x.agent] || 0) + x.count
  return { agentUnavailable: [...new Set(missing)].sort(), agentFallbacks }
}

/**
 * @param {unknown} report
 * @returns {{ missing: { agent: string, error: string }[], emptied: { agent: string, count: number, error?: string }[] }}
 */
function readAgentUnavailableSection(report) {
  /** @type {{ agent: string, error: string }[]} */
  const missing = []
  /** @type {{ agent: string, count: number, error?: string }[]} */
  const emptied = []
  const text = String(report ?? '')
  const head = text.indexOf('## ⚠️ Reviewer agent unavailable\n')
  if (head < 0) return { missing, emptied }
  for (const line of text.slice(head).split('\n').slice(1)) {
    if (!line.startsWith('- ')) break
    const got = readAgentUnavailableLine(line)
    if ('count' in got) emptied.push(got)
    else missing.push(got)
  }
  return { missing, emptied }
}

/** @param {string} line @returns {{ agent: string, error: string } | { agent: string, count: number, error?: string }} */
function readAgentUnavailableLine(line) {
  const hard = /^- `([^`]+)` is not registered in this session, .*? not broken\.(?: \((.*)\))?$/.exec(line)
  if (hard) return { agent: String(hard[1]), error: hard[2] || '' }
  const threw = /^- `([^`]+)` failed with "(.*)" on (\d+) /.exec(line)
  if (threw) return { agent: String(threw[1]), count: Number(threw[3]), error: threw[2] || '' }
  const empty = /^- `([^`]+)` returned nothing for (\d+) /.exec(line)
  if (empty) return { agent: String(empty[1]), count: Number(empty[2]) }
  return { agent: /`([^`]+)`/.exec(line)?.[1] || 'a craft agent', error: line.slice(2, 162) }
}
/** @type {Map<string, string>} */
const agentTypeMissing = new Map()      // agent type -> the error the engine saw
/** @type {Record<string, number>} */
const agentTypeEmptied = {}             // agent type -> dispatches that came back empty and the generic subagent answered
/** @type {Map<string, { count: number, error: string }>} */
const agentTypeNotFound = new Map()     // agent type -> dispatches that threw an unrecognised "not found" and the generic subagent answered
/**
 * @param {string} prompt
 * @param {AgentOptions} [opts]  the sandbox's closed option set — a misspelt key fails the type check
 * @returns {Promise<unknown>}
 */
async function safeAgent(prompt, opts = {}) {
  const at = opts['agentType']
  const generic = { ...opts }
  delete generic['agentType']
  if (!at || agentTypeMissing.has(at)) return agent(prompt, generic)
  try {
    const res = await agent(prompt, opts)
    if (res != null) return res
    return await genericAfterNull(prompt, generic, at)
  } catch (e) {
    return await genericAfterThrow(e, prompt, generic, at)
  }
}
/**
 * null: try generic once; don't memoize (may be transient). Counted only when the generic run
 * ANSWERED: the section says what entered the audit without the rubric, and a dispatch that died on
 * both paths is a dead dimension (NOT RUN), the same outcome as one that threw.
 * @param {string} prompt @param {AgentOptions} generic @param {string} at @returns {Promise<unknown>}
 */
async function genericAfterNull(prompt, generic, at) {
  const fallback = await agent(prompt, generic)
  if (fallback) agentTypeEmptied[at] = (agentTypeEmptied[at] || 0) + 1
  return fallback
}
/**
 * The agent type's dispatch threw: fall back to the generic subagent when the error says the type is
 * missing (memoized) or says "not found" in words that may mean it (not memoized); rethrow otherwise.
 * @param {unknown} e @param {string} prompt @param {AgentOptions} generic @param {string} at @returns {Promise<unknown>}
 */
async function genericAfterThrow(e, prompt, generic, at) {
  const msg = String((e && /** @type {{ message?: unknown }} */ (e).message) || e)
  if (!isAgentTypeMissing(msg, at)) {
    if (!/not found/i.test(msg)) throw e
    const fallback = await agent(prompt, generic)
    if (!fallback) throw e
    agentTypeNotFound.set(at, { count: (agentTypeNotFound.get(at)?.count || 0) + 1, error: msg })
    return fallback
  }
  agentTypeMissing.set(at, msg)
  log(`⚠️ agent type '${at}' not registered here — falling back to the generic subagent for the rest of this audit`)
  const fallback = await agent(prompt, generic)
  if (!fallback) throw e
  return fallback
}
/** @type {{ dimension: string, missing: { agent: string, error: string }[], emptied: { agent: string, count: number, error?: string }[] }[]} */
const nestedAgentNotes = []
/** @param {string} dimension @param {unknown} report */
function noteNestedAgents(dimension, report) {
  const got = readAgentUnavailableSection(report)
  if (got.missing.length || got.emptied.length) nestedAgentNotes.push({ dimension, ...got })
}
const agentSection = () => agentUnavailableSection(
  [
    ...[...agentTypeMissing].map(([agent, error]) => ({ agent, what: 'the audit dimensions that use it', error })),
    ...nestedAgentNotes.flatMap(n => n.missing.map(x => ({ agent: x.agent, what: `the lenses of the nested review ${n.dimension}`, error: x.error }))),
  ],
  [
    ...Object.entries(agentTypeEmptied).map(([agent, count]) => ({ agent, count, what: 'dimension dispatch(es)' })),
    ...[...agentTypeNotFound].map(([agent, x]) => ({ agent, count: x.count, what: 'dimension dispatch(es)', error: x.error })),
  ].filter(x => !agentTypeMissing.has(x.agent)).concat(
    nestedAgentNotes.flatMap(n => n.emptied.map(x => ({ ...x, what: `lens dispatch(es) of the nested review ${n.dimension}` })))),
)
const agentRecord = () => agentUnavailableRecord(
  agentTypeMissing.keys(),
  [
    ...Object.entries(agentTypeEmptied).map(([agent, count]) => ({ agent, count })),
    ...[...agentTypeNotFound].map(([agent, x]) => ({ agent, count: x.count })),
  ],
)

if (A['repo']) {
  const refused = repoRefusal({ engine: 'rust-audit', repo: String(A['repo']), craftVersion: CRAFT_VERSION, outputTokens: budget.spent() })
  await logRun(refused.record)
  return refused.report
}

/** The scout's step 1: the given base, or the fallbacks to try. @returns {string} */
function baseInstruction() {
  return baseArg
    ? `Use \`${baseArg}\` as the base ref.`
    : 'Try in order until one resolves: `git merge-base HEAD origin/main`, `git merge-base HEAD main`, `HEAD~1`.'
}

phase('Scout')
const scout = /** @type {ScoutResult | null} */ (await agent(
  `You are scouting a Rust workspace to plan an audit. Use shell commands only — do NOT review anything yet.

1. Determine the diff base. ${baseInstruction()}
2. hasDiff = true if \`git diff --name-only <base>...HEAD\` lists any \`.rs\` file, OR \`git status --porcelain\` shows uncommitted \`.rs\` changes.
3. hasUnsafe = true if \`grep -rnE "\\bunsafe\\b" --include=*.rs .\` finds any match (a rough check is fine; ignore obvious comment-only hits if cheap to do).
4. baseRef = the ref you actually used (empty string if none resolved).
5. crates = workspace members from \`cargo metadata --no-deps --format-version 1\` — each as {name, path} where path is the crate's manifest directory RELATIVE to the repo root. \`cargo metadata\` prints \`manifest_path\` as an ABSOLUTE file path: strip the repo root and the trailing \`/Cargo.toml\` yourself (the workspace root crate is \`.\`). An absolute path here cannot be used as a git pathspec and the per-crate review it feeds will refuse to run. Empty array if \`cargo metadata\` is unavailable.
5b. repoRoot = \`git rev-parse --show-toplevel\` (empty string if it fails). It is the fallback that lets the script repair an absolute crate path; it is not a substitute for step 5.
6. changedCrates = the subset of \`crates\` whose directory contains a \`.rs\` file listed by \`git diff --name-only <base>...HEAD\` (or \`git status --porcelain\` for uncommitted work). Empty if no base or no changed \`.rs\`.
7. edges = intra-workspace dependency edges from \`cargo metadata --format-version 1\`: {from, to} where BOTH \`from\` and \`to\` are workspace members and \`from\` depends on \`to\`. Empty array if \`cargo metadata\` is unavailable.`,
  { label: 'scout', schema: SCOUT_SCHEMA, model: 'haiku', effort: 'low' },
))
/**
 * What the audit reads from the scout. scout is null if the agent was skipped or died — fall back to
 * safe defaults rather than crash.
 * @param {ScoutResult | null} s
 * @returns {{ baseRef: string, hasUnsafe: boolean, repoRoot: string, crates: CrateItem[], changedCrates: CrateItem[], edges: EdgeItem[], notes: string }}
 */
function scoutFacts(s) {
  const noNotes = 'scout produced no result — assuming unsafe present, no base ref'
  if (!s) return { baseRef: '', hasUnsafe: true, repoRoot: '', crates: [], changedCrates: [], edges: [], notes: noNotes }
  return {
    baseRef: s.baseRef ?? '',
    hasUnsafe: s.hasUnsafe ?? true,
    repoRoot: typeof s.repoRoot === 'string' ? s.repoRoot.trim() : '',
    crates: Array.isArray(s.crates) ? s.crates : [],
    changedCrates: Array.isArray(s.changedCrates) ? s.changedCrates : [],
    edges: Array.isArray(s.edges) ? s.edges : [],
    notes: s.notes ?? noNotes,
  }
}
const { baseRef, hasUnsafe, repoRoot, crates, changedCrates, edges, notes: scoutNotes } = scoutFacts(scout)
async function recallOnce() {
  if (recalledByLauncher) return
  const r = await recallDecisions(p => agent(p, { label: 'memory-recall', phase: 'Scout', schema: MEMORY_RECALL_SCHEMA, effort: 'low' }), [], baseRef || baseArg)
  const { merged, parts, read, blocked, overrides } = mergeAndRead(r.decisions, passedList, parsePriorDecisions, r.inactive)
  memory = withDerived(withPassed(r.memory, passedAccepted, read.passed), read.prior.decisions)
  for (const x of blocked) log(`⚠️ priorDecisions: ${x}`)
  memory = { ...memory, why: [memory.why, ...blocked, ...overrides].join('; ') }
  nestedPriorDecisions = withDerivedIds(merged)
  nestedMemoryParts = parts
  if (r.memory.source === 'none') nestedMemoryNote = r.memory.why || 'the recall found none'
  if (passedDecisions != null && passedDecisions !== '' && !Array.isArray(passedDecisions)) {
    log('⚠️ priorDecisions is not a list — not forwarded to the nested reviews')
    memory = { ...memory, why: `${memory.why}; the launcher's priorDecisions was not a list — not applied` }
  }
}
await recallOnce()
const ABSOLUTE_PATH = /^(\/|~(\/|$)|[A-Za-z]:[\\/])/
/** @param {unknown} p */
function pathSegments(p) {
  const segs = []
  for (const s of String(p).split(/[\\/]+/)) {
    if (!s || s === '.') continue
    if (s === '..' && segs.length && segs[segs.length - 1] !== '..') { segs.pop(); continue }
    segs.push(s)
  }
  return segs
}
/** @param {unknown} p */
function crateScope(p) {
  const raw = String(p ?? '').trim()
  if (!raw) return null
  if (!ABSOLUTE_PATH.test(raw)) {
    const segs = pathSegments(raw)
    if (segs[0] === '..') return null
    return segs.join('/') || '.'
  }
  return absoluteScope(raw)
}
/** @param {string} raw @returns {string | null} */
function absoluteScope(raw) {
  const r = pathSegments(repoRoot)
  const abs = pathSegments(raw)
  if (!repoRoot || !r.length || abs.length < r.length) return null
  for (let i = 0; i < r.length; i++) if (abs[i] !== r[i]) return null
  return abs.slice(r.length).join('/') || '.'
}
log(scoutNotes)

phase('Audit')

/** @param {unknown} report */
function verdictLine(report) {
  const text = String(report || '')
  const m = /^[ \t]*#{1,6}[ \t]*Verdict\b(.*)$/im.exec(text)
  if (!m) return null
  const inline = String(m[1] || '').replace(/^[\s:：—–-]+/, '').trim()
  if (inline) return inline
  for (const line of text.slice(m.index + m[0].length).split('\n')) {
    const t = line.trim()
    if (t) return t
  }
  return null
}

/** @param {string | null} line @param {boolean} incomplete @returns {string} */
function reviewVerdict(line, incomplete) {
  if (line == null) return 'Warning'
  if (/⛔|Block/.test(line)) return 'Block'
  if (/⚠️|Warning/.test(line)) return 'Warning'
  if (incomplete) return 'Warning'
  return /✅|Approve/.test(line) ? 'Approve' : 'Warning'
}

/** @param {string | null} line @param {string} verdict @param {boolean} incomplete @returns {string} */
function reviewSummary(line, verdict, incomplete) {
  if (line == null) return 'Deep review verdict could not be read — this dimension is unverified, not clean.'
  if (verdict === 'Block') return `Deep review returned a BLOCK — blocking findings below${incomplete ? '; coverage was also partial, so there may be more' : ''}.`
  return incomplete
    ? 'Deep review did NOT run to completion — this dimension is uncovered, not clean.'
    : 'Elastic deep review — see findings below.'
}

/**
 * @param {string} dimension
 * @param {unknown} report
 */
function reviewResult(dimension, report) {
  const line = verdictLine(report)
  const incomplete = /INCOMPLETE|PARTIAL COVERAGE/i.test(line || '')
  const verdict = reviewVerdict(line, incomplete)
  const summary = reviewSummary(line, verdict, incomplete)
  const kept = liftPriorDecisionSections(String(report || 'no report'))
  return {
    dimension,
    verdict,
    summary,
    findings: [{ severity: 'Info', title: 'Deep review report', location: '', detail: kept.rest.slice(0, 4000) }],
    ...(kept.lifted ? { _priorDecisions: kept.lifted } : {}),
  }
}

const PRIOR_DECISION_HEADINGS = ['## Rejected before (set aside — not in the verdict)', '## Known and deferred (open question — not in the verdict)', '## Prior decisions not applied']

/**
 * The report without its prior-decision sections, and those sections, each from its heading to the
 * next `## ` heading or the end.
 * @param {string} report @returns {{ rest: string, lifted: string }}
 */
function liftPriorDecisionSections(report) {
  const lines = report.split('\n')
  /** @type {string[]} */
  const rest = []
  /** @type {string[]} */
  const lifted = []
  let inside = false
  for (const line of lines) {
    if (line.startsWith('## ')) inside = PRIOR_DECISION_HEADINGS.includes(line.trim())
    ;(inside ? lifted : rest).push(line)
  }
  return { rest: rest.join('\n'), lifted: lifted.join('\n').trim() }
}

/**
 * The outer report's section carrying every nested review's lifted text under its dimension; '' when
 * none had any.
 * @param {Array<{ dimension: string, text: string }>} lifted @returns {string}
 */
function nestedPriorDecisionsSection(lifted) {
  const given = lifted.filter(l => l.text)
  if (!given.length) return ''
  return `\n\n## Prior decisions in the nested reviews (verbatim)\n${given.map(l => `### ${l.dimension}\n${l.text}`).join('\n\n')}\n`
}

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

/**
 * @param {string} dimension
 * @param {DimResult | null | undefined} r agent result
 * @param {string} deadReason
 * @param {boolean} [evidenceGate]
 */
function dimResult(dimension, r, deadReason, evidenceGate = true) {
  if (!r) { log(`${dimension}: ${deadReason}`); return null }
  const tagged = { ...r, dimension }
  if (!evidenceGate) return tagged
  const demoted = demoteUnsupportedGreen(tagged)
  if (demoted !== tagged) log(`${dimension}: reported ${r.verdict} with no Evidence — demoted to ${demoted?.verdict}`)
  return demoted
}

/**
 * @param {string} dimension
 * @param {Promise<DimResult | null>} promise agent result
 * @param {{ deadReason?: string, threw?: (msg: unknown) => string, evidenceGate?: boolean }} [opts]
 */
function dispatchDim(dimension, promise, opts = {}) {
  const deadReason = opts.deadReason || 'agent returned no result (died or skipped) — dimension NOT RUN'
  const threw = opts.threw || (msg => `${dimension}: agent threw — ${msg} — dimension NOT RUN`)
  return promise
    .then(r => dimResult(dimension, r, deadReason, opts.evidenceGate ?? true))
    .catch((/** @type {unknown} */ e) => { log(threw((e && /** @type {{ message?: unknown }} */ (e).message) || e)); return null })
}

/** @type {Array<() => Promise<DimResult | null | undefined> | null>} */
const tasks = []
/** @type {string[]} */
const dispatched = []

/** Queues the review dimension: one nested review per crate, or one for the whole workspace. */
function pushReviewDims() {
  const reviewCrates = changedCrates.length ? changedCrates : (baseRef ? [] : crates)
  if (reviewCrates.length > 1) {
    for (const c of reviewCrates) {
      const scope = crateScope(c.path)
      if (scope == null) {
        log(`⚠️ crate ${c.name}: path=${String(c.path)} could not be made repo-relative (repoRoot=${repoRoot || 'unresolved'}) — its per-crate review is NOT RUN rather than silently widened to the whole workspace`)
        tasks.push(() => null)
        dispatched.push(`review:${c.name}`)
        continue
      }
      tasks.push(() => dispatchDim(`review:${c.name}`,
        nestedWorkflow(workflow, 'review', { base: baseRef, path: scope, languages: ['rust'], _via: 'rust-audit', ...nestedReviewArgs() }, log)
          .then(/** @param {unknown} report */ report => { if (report == null) return null; noteNestedAgents(`review:${c.name}`, report); return reviewResult(`review:${c.name}`, report) }),
        { deadReason: 'nested review returned no result (died) — dimension NOT RUN',
          threw: msg => `review:${c.name} failed: ${msg}`, evidenceGate: false }))
      dispatched.push(`review:${c.name}`)
    }
  } else {
    tasks.push(() => dispatchDim('review',
      nestedWorkflow(workflow, 'review', baseRef ? { base: baseRef, languages: ['rust'], _via: 'rust-audit', ...nestedReviewArgs() }
                                                  : { languages: ['rust'], _via: 'rust-audit', ...nestedReviewArgs() }, log)
        .then(/** @param {unknown} report */ report => { if (report == null) return null; noteNestedAgents('review', report); return reviewResult('review', report) }),
      { deadReason: 'nested review returned no result (died) — dimension NOT RUN',
        threw: msg => `review failed: ${msg}`, evidenceGate: false }))
    dispatched.push('review')
  }
}
pushReviewDims()

/** Queues one contract review per touched edge, or says why there are none. */
function pushContractDims() {
  const changedNames = new Set(changedCrates.map(c => c.name))
  const touchedEdges = edges.filter(e => !baseRef || changedNames.has(e.from) || changedNames.has(e.to))
  if (touchedEdges.length) {
    for (const e of touchedEdges) {
      tasks.push(() => dispatchDim(`contract:${e.from}→${e.to}`, /** @type {Promise<FindingsResult | null>} */ (safeAgent(
        `Review the call contract on the workspace dependency edge \`${e.from}\` → \`${e.to}\`: does \`${e.from}\` use \`${e.to}\`'s PUBLIC API the way its contract intends? Check signatures and types at the boundary, error and panic contracts, documented invariants and trait laws, and the semver/breaking-change compatibility of \`${e.to}\`'s public surface against \`${e.from}\`'s usage. Load the rust-review skill (the api-design pass), rust-errors (error contracts), and rust-traits (trait laws) for the rubric. Return a verdict and findings.\n\nObservability: the rust-audit workflow records this run — do NOT write your own record.`,
        { label: `contract:${e.from}->${e.to}`, agentType: 'craft:rust-reviewer', phase: 'Audit', schema: FINDINGS_SCHEMA, model: 'opus' },
      ))))
      dispatched.push(`contract:${e.from}→${e.to}`)
    }
  } else {
    log('No intra-workspace dependency edges to review — skipping the contracts dimension.')
  }
}
pushContractDims()

tasks.push(() => dispatchDim('crate-decomposition', /** @type {Promise<FindingsResult | null>} */ (agent(
  `Judge this Rust workspace's crate boundaries and recommend where code should be EXTRACTED into its own crate, or where an over-split crate should be MERGED back. Load the rust-ecosystem skill and its crate-extraction.md rubric, and build on the workspace dependency graph (\`cargo metadata\`). For EACH recommendation give: the DRIVER (reuse / compile parallelism / dependency inversion / trust boundary / independent semver / test isolation / god-crate split — or, for a merge, "single consumer, no boundary reason"), the BOUNDARY (which module or code), and the HOW. Recommend only — do NOT move code. Return a verdict (Healthy / Concerns / At-risk) and findings. Fill the \`evidence\` field with one line beginning \`Evidence:\` naming the exact commands you ran (e.g. \`cargo metadata\`) and manifests you read this pass — a passing verdict with an empty evidence field is treated as INCOMPLETE, not trusted.`,
  { label: 'crate-decomposition', phase: 'Audit', schema: FINDINGS_SCHEMA, effort: 'medium' },
))))
dispatched.push('crate-decomposition')

tasks.push(() => dispatchDim('architecture', /** @type {Promise<FindingsResult | null>} */ (safeAgent(
  `Audit the architecture of this whole Rust project against the rust-architecture-review rubric (load the rust-architecture-review skill). Build the crate/module dependency graph and judge the structure in BOTH directions — too little (layer leaks, god modules) and too much (ghost abstractions, over-layering). Return your health rating and findings. If NO dependency graph could be built at all (cargo metadata/tree failed, cargo-modules absent, and no manifest or source structure was readable), nothing was judged: return verdict "INCOMPLETE (not run)" naming what was missing — not "Healthy". A graph built from the source fallback IS a graph: rate it normally.\n\nObservability: the rust-audit workflow records this run — do NOT write your own record.`,
  { label: 'architecture', agentType: 'craft:rust-architecture-reviewer', phase: 'Audit', schema: FINDINGS_SCHEMA },
))))
dispatched.push('architecture')

tasks.push(() => dispatchDim('security', /** @type {Promise<FindingsResult | null>} */ (safeAgent(
  `Run the Rust security toolchain (cargo-audit, cargo-deny, cargo-geiger, semgrep — whatever is available) against the rust-security rubric (load the rust-security skill). Consolidate into a severity-ranked verdict and findings. If NONE of the tools is installed, so nothing was actually scanned, return verdict "INCOMPLETE (not run)" and name the missing tools — a scan that ran nothing is not an Approve.\n\nObservability: the rust-audit workflow records this run — do NOT write your own record.`,
  { label: 'security', agentType: 'craft:rust-security-scanner', phase: 'Audit', schema: FINDINGS_SCHEMA, model: 'opus' },
))))
dispatched.push('security')

/** Queues Miri when the workspace has unsafe code, or says it is skipped. */
function pushMiriDim() {
  if (hasUnsafe) {
    tasks.push(() => dispatchDim('miri', /** @type {Promise<FindingsResult | null>} */ (safeAgent(
      `This workspace contains unsafe code. Run its tests under Miri and report any undefined behavior against the rust-unsafe rubric (load the rust-unsafe skill). Return a verdict (Clean / UB-found), or "INCOMPLETE (not run)" if the nightly toolchain or miri itself is unavailable so nothing was executed under Miri — an unrun Miri is NOT Clean. Return findings.\n\nObservability: the rust-audit workflow records this run — do NOT write your own record.`,
      { label: 'miri', agentType: 'craft:rust-miri', phase: 'Audit', schema: FINDINGS_SCHEMA, model: 'opus' },
    ))))
    dispatched.push('miri')
  } else {
    log('No unsafe code detected — skipping Miri.')
  }
}
pushMiriDim()

tasks.push(() => dispatchDim('semver', /** @type {Promise<FindingsResult | null>} */ (agent(
  `Check public-API semver compatibility across the workspace's PUBLISHED crates. Run \`cargo semver-checks check-release\` (per published crate as needed). If \`cargo-semver-checks\` is not installed, say so and return verdict "INCOMPLETE (not run)" with a one-line note naming what was missing — do NOT fail, and do NOT return Approve: nothing was checked. If the tool IS available but there is no published library crate to check, that is a real, complete answer — return "Approve" with a note that the workspace publishes no library. Load the rust-ecosystem skill (semver/publishing) and the rust-review api-design pass. Report breaking changes vs the published baseline as findings. Fill the \`evidence\` field with one line beginning \`Evidence:\` naming the exact commands you ran and crates you checked this pass — a passing verdict with an empty evidence field is treated as INCOMPLETE, not trusted.`,
  { label: 'semver', phase: 'Audit', schema: FINDINGS_SCHEMA, effort: 'low' },
))))
dispatched.push('semver')

tasks.push(() => dispatchDim('build-matrix', /** @type {Promise<FindingsResult | null>} */ (agent(
  `Check the build across feature combinations and the MSRV. If \`cargo-hack\` is installed: \`cargo hack check --feature-powerset --no-dev-deps\`, plus \`cargo check --no-default-features\` and \`cargo check --all-features\`. For MSRV: read \`rust-version\` from Cargo.toml and run \`cargo hack --rust-version check\` (or \`cargo +<rust-version> check\` if that toolchain is installed). Skip any tool/toolchain that is absent with a note. If NOTHING could run, return verdict "INCOMPLETE (not run)" naming what was missing — do NOT fail, and do NOT return Approve: no feature combination was actually built. Return "Approve" only if at least one check ran and passed. Load the rust-ecosystem skill. Report failing feature combinations or MSRV breakage as findings. Fill the \`evidence\` field with one line beginning \`Evidence:\` naming the exact commands you ran (feature sets, MSRV checks) this pass — a passing verdict with an empty evidence field is treated as INCOMPLETE, not trusted.`,
  { label: 'build-matrix', phase: 'Audit', schema: FINDINGS_SCHEMA, effort: 'low' },
))))
dispatched.push('build-matrix')

tasks.push(() => dispatchDim('deps', /** @type {Promise<FindingsResult | null>} */ (agent(
  `Audit dependency HYGIENE (distinct from security vulns/licenses). Run \`cargo tree -d\` (duplicate/conflicting versions that bloat the build and binary) and \`cargo outdated\` (out-of-date deps). Do NOT check unused dependencies here — the \`unused-crates\` dimension owns that (with verification). Skip any tool that is not installed with a note — do NOT fail; but if NEITHER tool is installed, so no dependency hygiene was actually inspected, return verdict "INCOMPLETE (not run)" naming the missing tools rather than "Approve". Load the rust-ecosystem skill (dependency weight/hygiene). Report duplicates and notably out-of-date deps as findings. Fill the \`evidence\` field with one line beginning \`Evidence:\` naming the exact commands you ran (e.g. \`cargo tree -d\`, \`cargo outdated\`) this pass — a passing verdict with an empty evidence field is treated as INCOMPLETE, not trusted.`,
  { label: 'deps', phase: 'Audit', schema: FINDINGS_SCHEMA, effort: 'low' },
))))
dispatched.push('deps')

tasks.push(() => dispatchDim('unused-crates', (async () => {
  const found = /** @type {FindingsResult | null} */ (await agent(
    `Find UNUSED crates in this Rust workspace, in two classes:
(a) ORPHAN workspace members — from \`cargo metadata --format-version 1\`, workspace members that NO other workspace member depends on (any dependency kind), EXCLUDING binaries (a [[bin]] target or src/main.rs) and published libraries (Cargo.toml \`publish\` is not false / it is meant for crates.io).
(b) UNUSED dependencies — run \`cargo machete\` (or \`cargo +nightly udeps\` if machete is absent) to list dependencies declared in a Cargo.toml but not used.
Skip a tool that is not installed with a note — do NOT fail. \`cargo metadata\` alone answers class (a), so it is enough to run: if the graph loads and there are no orphan members, that is a real "Approve" with an empty findings list. But if \`cargo metadata\` itself does not run, so NOTHING was inspected, return verdict "INCOMPLETE (not run)" naming what was missing — not "Approve".
Load the rust-ecosystem skill (dependency / crate hygiene).
These are CANDIDATES, not confirmed — they will be verified downstream. Return one finding per candidate: title = "orphan-member: <crate>" or "unused-dep: <dep> in <crate>", location = the owning manifest path, detail = why the graph/tool thinks it is unused. Use severity Info (verification sets the real severity).`,
    { label: 'unused-crates:find', phase: 'Audit', schema: FINDINGS_SCHEMA, effort: 'low' },
  ))
  if (!found) return null
  const candidates = (Array.isArray(found.findings) ? found.findings : [])
    .filter(f => /^(orphan-member|unused-dep):/.test(f.title || ''))
  if (!candidates.length) {
    const t = tallyVerification(candidates, [])
    const evidence = GREEN_VERDICT.test(String(found.verdict ?? '')) ? unusedEvidence(t) : (found.evidence ?? '')
    return { ...found, dimension: 'unused-crates', evidence, _verification: { candidates: 0, confirmed: 0, refuted: 0, died: 0, judged: 0, refuteRate: null } }
  }
  const verdicts = await parallel(candidates.map((c, i) => () =>
    /** @type {Promise<UnusedVerdict | null>} */ (agent(
      `A detector flagged a crate/dependency as UNUSED. Try HARD to REFUTE that — prove it IS used — before accepting it. Candidate: ${JSON.stringify(c)}.
Check the usages machete/udeps and the dependency graph miss: \`use\`/path references; cfg-gated and feature-gated usage; macro-only and re-exported (\`pub use\`) usage; build.rs / [build-dependencies]; [dev-dependencies] exercised only in tests, benches, or examples; and for an orphan member whether it is actually a bin, an example/bench/xtask, or consumed/published outside this workspace. Grep the source to confirm.
Set confirmedUnused=true ONLY if it is genuinely unused and safe to remove; default to false when uncertain.`,
      { label: `unused-crates:verify#${i + 1}`, phase: 'Verify', schema: UNUSED_VERDICT_SCHEMA, model: 'opus' },
    )).then(v => wrapVerdict(c, v)),
  ))
  return unusedCratesResult(candidates, verdicts)
})()))
dispatched.push('unused-crates')

/** The tests-cov brief's mutation-testing clause: run it only when asked. @returns {string} */
function mutantsInstruction() {
  return runMutants ? ' Run `cargo mutants --timeout 60`, time-boxed, to surface weak spots (it is slow).' : ' Do NOT run cargo mutants (not requested via {mutants:true}).'
}
tasks.push(() => dispatchDim('tests-cov', /** @type {Promise<FindingsResult | null>} */ (agent(
  `Assess test effectiveness and docs. Run \`cargo llvm-cov --summary-only\` (overall coverage + worst-covered files) if \`cargo-llvm-cov\` is installed.${mutantsInstruction()} Build docs cleanly: \`cargo doc --no-deps\` (flag broken intra-doc links) and run doctests (\`cargo test --doc\`). Skip any tool that is not installed with a note — do NOT fail; but if NONE of them ran (no coverage tool, no doc build, no doctests), return verdict "INCOMPLETE (not run)" naming the missing tools rather than "Approve" — nothing was measured. Load the rust-testing skill (coverage/mutation/doctests) and rust-idioms (rustdoc). Report low-coverage hotspots, surviving mutants, broken doc links, and failing doctests as findings. Fill the \`evidence\` field with one line beginning \`Evidence:\` naming the exact commands you ran (coverage, doc build, doctests) this pass — a passing verdict with an empty evidence field is treated as INCOMPLETE, not trusted.`,
  { label: 'tests-cov', phase: 'Audit', schema: FINDINGS_SCHEMA, effort: 'low' },
))))
dispatched.push('tests-cov')

const results = (await parallel(tasks)).filter(r => !!r).map(r => ({ ...r, verdict: normalizeDimensionVerdict(r.verdict) }))

const ran = new Set(results.map(r => r.dimension))
const notRun = dispatched.filter(d => !ran.has(d))
const couldNotRun = results.filter(r => /^\s*INCOMPLETE \(not run\)/i.test(String(r.verdict || ''))).map(r => r.dimension)
const noEvidence = results.filter(r => /^\s*INCOMPLETE \(no evidence/i.test(String(r.verdict || ''))).map(r => r.dimension)
const incompleteDimensions = [...notRun, ...results.filter(r => /^\s*INCOMPLETE/i.test(String(r.verdict || ''))).map(r => r.dimension)]
/** Logs each kind of dimension that did not answer for its coverage. */
function logGaps() {
  if (notRun.length) log(`No result from: ${notRun.join(', ')} — flagged NOT RUN in the report.`)
  if (couldNotRun.length) log(`Tooling absent, nothing checked: ${couldNotRun.join(', ')} — flagged COULD NOT RUN in the report.`)
  if (noEvidence.length) log(`Reported a green but showed no Evidence: ${noEvidence.join(', ')} — flagged NO EVIDENCE (verdict not trusted) in the report.`)
}
logGaps()
/** @param {string[]} names @returns {string} */
const listOrNone = names => names.length ? names.join(', ') : 'none'

const stripped = results.map(stripInternal)

phase('Synthesize')
const report = await agent(
  `You are consolidating a Rust audit. Below are JSON results from independent review agents. Dimensions come in families: \`review:<crate>\` (one per crate reviewed), \`contract:<from>→<to>\` (one per inter-crate dependency edge), \`crate-decomposition\` (extract/merge recommendations), \`architecture\`, \`security\`, \`miri\`, and the tool dimensions \`semver\`/\`build-matrix\`/\`deps\`/\`unused-crates\` (verified orphan workspace members + unused dependencies)/\`tests-cov\`. Produce ONE markdown report — do not invent findings, only merge what is given:

1. An **overall verdict** line — the worst case across all dimensions. If any dimension did not run, or could not run, mark the audit INCOMPLETE.
2. A **dimension → verdict** table with one row per dimension present (list each \`review:<crate>\` and \`contract:<from>→<to>\` separately). Add a row for every dimension under NOT RUN below with verdict \`NOT RUN\` — its agent failed, so do not treat its absence as a pass. Any dimension listed under COULD NOT RUN below (verdict \`INCOMPLETE (not run)\`) must be rendered as \`COULD NOT RUN\` with a note naming the missing tool. Any dimension listed under NO EVIDENCE below (verdict \`INCOMPLETE (no evidence …)\`) must be rendered as \`NO EVIDENCE\` — it claimed a green but showed no work, so its verdict is not trusted; the tool may have run, so do NOT call it tooling-absent. NEVER render either as Approve or as a blank/green cell: a reader must be able to tell "ran, found nothing" from "never ran" from "claimed clean but showed nothing". Directly beneath the table, state in one line how many dimensions actually ran out of the total.
3. **Findings by severity** (Critical first), each tagged with its dimension and location, plus a one-line fix direction.
4. A short **"Fix first"** list — the few highest-leverage items across all dimensions.
5. A **"Crate boundaries"** note: summarise the \`crate-decomposition\` extract/merge recommendations (driver + boundary), if any.
6. If a \`review:*\` dimension's summary names a **gate provenance** (CI vs local), surface it in one line under the verdict.

NOT RUN (no result — agent failed or was skipped): ${listOrNone(notRun)}
COULD NOT RUN (agent reported back, but its tooling was absent so nothing was checked — treat as uncovered, never as a pass): ${listOrNone(couldNotRun)}
NO EVIDENCE (agent claimed a green but showed no work, so its verdict is not trusted — the tool may have run; treat as uncovered, never as a pass, but do NOT assert its tooling was absent): ${listOrNone(noEvidence)}

RESULTS:
${JSON.stringify(stripped, null, 2)}`,
  { label: 'synthesis', effort: 'medium' },
)

const uc = results.find(r => r.dimension === 'unused-crates')
/** The unused-crates verification as the record stores it, or null when that dimension did not verify. @param {DimResult | undefined} u */
function verificationRecord(u) {
  if (!u || !u._verification) return null
  const v = u._verification
  return {
    candidates: v.candidates,
    confirmed: v.confirmed,
    refuted: v.refuted ?? null,
    died: v.died ?? null,
    judged: v.judged ?? null,
    refuteRate: v.refuteRate ?? null,
  }
}
const auditRecord = {
  schemaVersion: 1,
  runtime: 'claude-code',
  craftVersion: CRAFT_VERSION,
  kind: 'workflow',
  name: 'rust-audit',
  verdict: auditVerdict(worstVerdict(results.map(r => r.verdict)), incompleteDimensions),
  findings: summarizeFindings(results.flatMap(r => (Array.isArray(r.findings) ? r.findings : []))),
  nested: false,
  via: null,
  scout: { baseRef, crateCount: crates.length, changedCrateCount: changedCrates.length, edgeCount: edges.length, hasUnsafe },
  dimensions: stripped.map(r => {
    const s = summarizeFindings(r['findings'])
    return { dimension: r['dimension'], verdict: r['verdict'], findingCount: s.total, bySeverity: s.bySeverity }
  }),
  verification: verificationRecord(uc),
  notRun,
  couldNotRun,
  noEvidence,
  ...agentRecord(),
  outputTokens: budget.spent(),
}
await logRun(auditRecord)

if (typeof report !== 'string' || !report.trim()) return `${telemetryLostSection(telemetryLost)}${agentSection()}⚠️ INCOMPLETE — the Synthesize agent returned no result, so this audit has NO report. Nothing here is an approval; re-run it.${nestedPriorDecisionsSection(results.map(r => ({ dimension: r.dimension, text: r._priorDecisions || '' })))}${memorySection(memory, true)}`
return `${telemetryLostSection(telemetryLost)}${agentSection()}${report}${nestedPriorDecisionsSection(results.map(r => ({ dimension: r.dimension, text: r._priorDecisions || '' })))}${memorySection(memory, true)}`
