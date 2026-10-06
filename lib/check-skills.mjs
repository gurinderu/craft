// Static integrity check for the collection's authored config: every skill and agent has a valid
// frontmatter block, its `name` matches the directory/file it lives in, and every internal
// `craft:<slug>` cross-reference in any skill/agent/workflow resolves to a real skill, agent, or
// workflow. Catches the failure class that the unit tests can't: a renamed skill leaving a dangling
// `craft:` pointer, or a new skill shipped with a malformed/empty description. Pure helpers are
// exported for the unit test; the filesystem walk lives in `run` at the bottom (CLI mode).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { outputLines, runIfMain } from './script-main.mjs'

// Parse a Markdown YAML frontmatter block into a Map of top-level key -> collapsed string value.
// Handles both inline scalars (`name: foo`, `tools: ["Read"]`) and folded/literal block scalars
// (`description: >-` followed by indented continuation lines). Returns null when there is no
// frontmatter block at all. Not a general YAML parser — only what this collection's frontmatter uses.
/**
 * @param {string} src
 * @returns {Map<string, string> | null}
 */
export function parseFrontmatter(src) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src)
  if (!m) return null
  const keys = new Map()
  /** @type {string | null} */
  let curKey = null
  /** @type {string[]} */
  let parts = []
  const flush = () => { if (curKey !== null) keys.set(curKey, parts.join(' ').replace(/\s+/g, ' ').trim()) }
  for (const line of /** @type {string} */ (m[1]).split(/\r?\n/)) {
    const km = /^([A-Za-z][\w-]*):(.*)$/.exec(line) // top-level key: indented lines never match `^[A-Za-z]`
    if (km) {
      flush()
      curKey = /** @type {string} */ (km[1])
      const inline = /** @type {string} */ (km[2]).trim()
      parts = inline && !/^[|>][+-]?$/.test(inline) ? [inline] : [] // drop a bare block indicator (>- | …)
    } else if (curKey !== null) {
      parts.push(line.trim())
    }
  }
  flush()
  return keys
}

// Anthropic's documented limits: `name` <= 64 chars, `description` <= 1024 chars, and a SKILL.md
// body kept under ~500 lines for progressive-disclosure performance.
const NAME_MAX = 64
const DESC_MAX = 1024
const BODY_MAX_LINES = 500

// Lint one skill's frontmatter. `dirName` is the skill's directory basename (its canonical id).
/**
 * @param {string} dirName
 * @param {Map<string, string> | null} keys
 * @returns {string[]}
 */
export function lintSkill(dirName, keys) {
  if (!keys) return ['no frontmatter block']
  const errs = []
  const name = keys.get('name')
  if (!name) errs.push('missing name')
  else if (name !== dirName) errs.push(`name "${name}" != dir "${dirName}"`)
  else if (name.length > NAME_MAX) errs.push(`name too long (${name.length} > ${NAME_MAX} chars)`)
  const desc = keys.get('description')
  if (!desc) errs.push('missing/empty description')
  else if (desc.length > DESC_MAX) errs.push(`description too long (${desc.length} > ${DESC_MAX} chars)`)
  return errs
}

// Lint one agent's frontmatter. `fileBase` is the agent file's basename without .md (its id).
/**
 * @param {string} fileBase
 * @param {Map<string, string> | null} keys
 * @returns {string[]}
 */
export function lintAgent(fileBase, keys) {
  if (!keys) return ['no frontmatter block']
  const errs = []
  const name = keys.get('name')
  if (!name) errs.push('missing name')
  else if (name !== fileBase) errs.push(`name "${name}" != file "${fileBase}"`)
  else if (name.length > NAME_MAX) errs.push(`name too long (${name.length} > ${NAME_MAX} chars)`)
  const desc = keys.get('description')
  if (!desc) errs.push('missing/empty description')
  else if (desc.length > DESC_MAX) errs.push(`description too long (${desc.length} > ${DESC_MAX} chars)`)
  if (!keys.get('tools')) errs.push('missing tools')
  if (!keys.get('model')) errs.push('missing model')
  return errs
}

// All internal `craft:<slug>` references found in a blob of text (skill body, agent prompt, …).
/**
 * @param {string} text
 * @returns {Set<string>}
 */
export function extractCraftRefs(text) {
  const out = new Set()
  for (const m of text.matchAll(/craft:([a-z][a-z0-9-]*)/g)) out.add(/** @type {string} */ (m[1]))
  return out
}

// Which of `refs` do not resolve against the set of known ids (skills ∪ agents ∪ workflows).
/**
 * @param {Iterable<string>} refs
 * @param {{ has(id: string): boolean }} known
 * @returns {string[]}
 */
export function unresolvedRefs(refs, known) {
  return [...refs].filter(r => !known.has(r)).sort()
}

// Every `<plugin>:<slug>` reference to a plugin listed in `foreign`. craft is self-contained —
// it declares no plugin dependencies and must not name another plugin's skills in its bodies — so
// the CLI fails when one of these reappears (e.g. a re-introduced `superpowers:` deferral).
/**
 * @param {string} text
 * @param {{ has(plugin: string): boolean }} foreign
 * @returns {string[]}
 */
export function extractForeignRefs(text, foreign) {
  const out = new Set()
  for (const m of text.matchAll(/\b([a-z][a-z0-9-]*):([a-z][a-z0-9-]*)/g)) {
    if (foreign.has(/** @type {string} */ (m[1]))) out.add(`${m[1]}:${m[2]}`)
  }
  return [...out].sort()
}

// Every Markdown file under `dir`, recursively (a skill's SKILL.md plus every sub-file, including
// ones nested in subdirectories). Returned as absolute paths. Used to scan a whole skill for
// foreign-plugin refs, not just its top-level files.
/**
 * @param {string} dir
 * @returns {string[]}
 */
export function collectMdFiles(dir) {
  return fs.readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter(f => f.endsWith('.md'))
    .map(f => path.join(dir, f))
}

// Dependency entries (plugin.json `dependencies` + each marketplace plugin's `dependencies`) whose
// plugin name is in `foreign`. Dependency form is `name` or `name@marketplace` — NOT the `name:slug`
// body form — so this is a separate check from extractForeignRefs.
/**
 * @param {{ dependencies?: unknown[], plugins?: { dependencies?: unknown[] }[] }} manifest
 * @param {{ has(plugin: string): boolean }} foreign
 * @returns {unknown[]}
 */
export function foreignDependencies(manifest, foreign) {
  const deps = [
    ...(manifest.dependencies || []),
    ...((manifest.plugins || []).flatMap(p => p.dependencies || [])),
  ]
  return deps.filter(d => foreign.has(/** @type {string} */ (String(d).split('@')[0]))).sort()
}

// Relative Markdown link targets in `text` — the `foo.md` / `sub/foo.md` inside `](…)`, with any
// `#anchor` stripped. Skips URLs (a scheme like `http:`/`mailto:`), absolute paths, and non-`.md`
// targets. Used to verify a skill's sub-file links resolve, so a rename can't leave a dead link.
/**
 * @param {string} text
 * @returns {string[]}
 */
export function extractRelMdLinks(text) {
  const out = new Set()
  for (const m of text.matchAll(/\]\(([^)]+?)\)/g)) {
    const target = /** @type {string} */ (/** @type {string} */ (m[1]).trim().split('#')[0]).trim()
    if (!target || target.startsWith('/')) continue
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue // has a URL scheme
    if (target.endsWith('.md')) out.add(target)
  }
  return [...out].sort()
}

// ── CLI mode ──────────────────────────────────────────────────────────────────────────────────
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** @typedef {{ stdout: string[], stderr: string[] }} Lines */
// Plugins craft must stay decoupled from: a `<plugin>:<slug>` ref to any of these fails the check.
const FOREIGN = new Set(['superpowers'])
/** @param {string} src */
const foreign = src => extractForeignRefs(src, FOREIGN).map(r => `foreign plugin ref ${r} (craft is self-contained)`)
/** @param {string} p */
const read = p => fs.readFileSync(p, 'utf8')
/** @typedef {(where: string, msgs: string[]) => void} Fail */

/** @param {string} root @returns {{ skills: string[], agents: string[], wfNames: string[] }} */
function inventory(root) {
  const skillsDir = path.join(root, 'skills')
  const wfDir = path.join(root, 'workflows')
  return {
    skills: fs.readdirSync(skillsDir).filter(d => fs.existsSync(path.join(skillsDir, d, 'SKILL.md'))).sort(),
    agents: fs.readdirSync(path.join(root, 'agents')).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)).sort(),
    // meta.name is the first `name:` in each script
    wfNames: /** @type {string[]} */ (fs.readdirSync(wfDir).filter(f => f.endsWith('.js'))
      .map(f => /name:\s*'([a-z][a-z0-9-]*)'/.exec(read(path.join(wfDir, f)))?.[1]).filter(Boolean)),
  }
}

/** @param {string} skillDir @param {string} s @param {Set<string>} known @param {Fail} fail */
function checkSkill(skillDir, s, known, fail) {
  const src = read(path.join(skillDir, 'SKILL.md'))
  fail(`skills/${s}`, lintSkill(s, parseFrontmatter(src)))
  const nLines = src.split(/\r?\n/).length
  if (nLines > BODY_MAX_LINES) fail(`skills/${s}`, [`SKILL.md too long (${nLines} > ${BODY_MAX_LINES} lines — keep the body lean, split into sub-files)`])
  fail(`skills/${s}`, unresolvedRefs(extractCraftRefs(src), known).map(r => `dangling craft:${r}`))
  // Per skill file (SKILL.md + every sub-file, recursively): no foreign-plugin refs, and every
  // relative `.md` link must resolve (a rename must not leave a dead sub-file link).
  for (const md of collectMdFiles(skillDir)) {
    const where = `skills/${s}/${path.relative(skillDir, md)}`
    const body = read(md)
    fail(where, foreign(body))
    fail(where, extractRelMdLinks(body)
      .filter(link => !fs.existsSync(path.resolve(path.dirname(md), link)))
      .map(link => `dead link → ${link}`))
  }
}

/** @param {string} root @param {string[]} agents @param {Set<string>} known @param {Fail} fail */
function checkAgentsAndWorkflows(root, agents, known, fail) {
  for (const a of agents) {
    const src = read(path.join(root, 'agents', `${a}.md`))
    fail(`agents/${a}`, lintAgent(a, parseFrontmatter(src)))
    fail(`agents/${a}`, unresolvedRefs(extractCraftRefs(src), known).map(r => `dangling craft:${r}`))
    fail(`agents/${a}`, foreign(src))
  }
  const wfDir = path.join(root, 'workflows')
  for (const f of fs.readdirSync(wfDir).filter(f => f.endsWith('.js'))) {
    const src = read(path.join(wfDir, f))
    fail(`workflows/${f}`, unresolvedRefs(extractCraftRefs(src), known).map(r => `dangling craft:${r}`))
    fail(`workflows/${f}`, foreign(src))
  }
}

/** @param {string} root @param {Fail} fail */
function checkDocsAndManifests(root, fail) {
  // Self-containment also covers the prose docs the decoupling touched (not lib/ — its tests carry
  // the `superpowers:` string on purpose; not docs/ — a historical design archive).
  for (const rel of ['README.md', 'MAP.md', 'CLAUDE.md', 'opencode/README.md', 'opencode/install.sh']) {
    const p = path.join(root, rel)
    if (fs.existsSync(p)) fail(rel, foreign(read(p)))
  }
  // Manifests must not re-declare a dependency on a forbidden plugin.
  for (const rel of ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json']) {
    const p = path.join(root, rel)
    if (fs.existsSync(p)) fail(rel, foreignDependencies(JSON.parse(read(p)), FOREIGN)
      .map(d => `forbidden dependency ${d} (craft is self-contained)`))
  }
}

/**
 * The whole scan; takes no arguments.
 * @param {string[]} _argv @param {NodeJS.ProcessEnv} _env  unused: it reads no environment
 * @param {string} [root]  the checkout to check
 * @returns {Promise<import('./script-main.mjs').ScriptResult>}
 */
export async function run(_argv, _env, root = ROOT) {
  /** @type {Lines} */
  const o = outputLines()
  let errors = 0
  /** @type {Fail} */
  const fail = (where, msgs) => { for (const m of msgs) { o.stderr.push(`FAIL  ${where} :: ${m}`); errors++ } }
  const { skills, agents, wfNames } = inventory(root)
  const known = new Set([...skills, ...agents, ...wfNames])

  // An empty scan is a broken checker, not a clean repo. With zero inputs every loop below is a
  // no-op and the run ends `all clean` — the most permissive outcome from the case where the
  // checker understood nothing. craft always ships all three, so this can only fire on a real
  // misconfiguration, never on a healthy run. What is left after a directory that is GONE (readdirSync
  // throws above) is a directory that exists and yields nothing — emptied by a move, or (for
  // skills/) holding only subdirectories with no SKILL.md.
  for (const [what, list] of /** @type {[string, string[]][]} */ ([['skills/', skills], ['agents/', agents], ['workflows/', wfNames]])) {
    if (!list.length) fail(what, [`no entries found — nothing was checked (this is a misconfiguration, not a pass)`])
  }
  for (const s of skills) checkSkill(path.join(root, 'skills', s), s, known, fail)
  checkAgentsAndWorkflows(root, agents, known, fail)
  checkDocsAndManifests(root, fail)

  o.stdout.push(`checked ${skills.length} skills, ${agents.length} agents, ${wfNames.length} workflows`)
  o.stdout.push(errors ? `\n${errors} problem(s)` : '\nall clean')
  return { exitCode: errors ? 1 : 0, ...o }
}

await runIfMain(import.meta.url, run)
