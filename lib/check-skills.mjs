// Static integrity check for the collection's authored config: every skill and agent has a valid
// frontmatter block, its `name` matches the directory/file it lives in, and every internal
// `craft:<slug>` cross-reference in any skill/agent/workflow resolves to a real skill, agent, or
// workflow. Catches the failure class that the unit tests can't: a renamed skill leaving a dangling
// `craft:` pointer, or a new skill shipped with a malformed/empty description. Pure helpers are
// exported for the unit test; the filesystem walk + process.exit live at the bottom (CLI mode).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

// Every Markdown file under `dir`, recursively (a skill's SKILL.md plus every sub-file, including
// ones nested in subdirectories). Returned as absolute paths for checking relative links.
/**
 * @param {string} dir
 * @returns {string[]}
 */
export function collectMdFiles(dir) {
  return fs.readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter(f => f.endsWith('.md'))
    .map(f => path.join(dir, f))
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
if (import.meta.url === `file://${process.argv[1]}`) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  /** @param {string} p */
  const read = p => fs.readFileSync(p, 'utf8')
  let errors = 0
  /**
   * @param {string} where
   * @param {string[]} msgs
   */
  const fail = (where, msgs) => { for (const m of msgs) { console.error('FAIL ', where, '::', m); errors++ } }

  const skillsDir = path.join(root, 'skills')
  const skills = fs.readdirSync(skillsDir).filter(d => fs.existsSync(path.join(skillsDir, d, 'SKILL.md'))).sort()
  const agentsDir = path.join(root, 'agents')
  const agents = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)).sort()
  const wfDir = path.join(root, 'workflows')
  const wfNames = /** @type {string[]} */ (fs.readdirSync(wfDir).filter(f => f.endsWith('.js')) // meta.name is the first `name:` in each script
    .map(f => /name:\s*'([a-z][a-z0-9-]*)'/.exec(read(path.join(wfDir, f)))?.[1]).filter(Boolean))
  const known = new Set([...skills, ...agents, ...wfNames])

  // An empty scan is a broken checker, not a clean repo. With zero inputs every loop below is a
  // no-op and the run ends `all clean` — the most permissive outcome from the case where the
  // checker understood nothing. craft always ships all three, so this can only fire on a real
  // misconfiguration, never on a healthy run. Narrower than it looks: `root` comes from
  // import.meta.url, so the cwd cannot move it, and a directory that is GONE makes readdirSync
  // throw above rather than reach here. What is left is a directory that exists and yields nothing
  // — emptied by a move, or (for skills/) holding only subdirectories with no SKILL.md.
  for (const [what, list] of /** @type {[string, string[]][]} */ ([['skills/', skills], ['agents/', agents], ['workflows/', wfNames]])) {
    if (!list.length) fail(what, [`no entries found — nothing was checked (this is a misconfiguration, not a pass)`])
  }

  for (const s of skills) {
    const skillDir = path.join(skillsDir, s)
    const src = read(path.join(skillDir, 'SKILL.md'))
    fail(`skills/${s}`, lintSkill(s, parseFrontmatter(src)))
    const nLines = src.split(/\r?\n/).length
    if (nLines > BODY_MAX_LINES) fail(`skills/${s}`, [`SKILL.md too long (${nLines} > ${BODY_MAX_LINES} lines — keep the body lean, split into sub-files)`])
    fail(`skills/${s}`, unresolvedRefs(extractCraftRefs(src), known).map(r => `dangling craft:${r}`))
    // Every relative `.md` link in the skill tree must resolve (a rename must not leave a dead link).
    for (const md of collectMdFiles(skillDir)) {
      const where = `skills/${s}/${path.relative(skillDir, md)}`
      const body = read(md)
      fail(where, extractRelMdLinks(body)
        .filter(link => !fs.existsSync(path.resolve(path.dirname(md), link)))
        .map(link => `dead link → ${link}`))
    }
  }
  for (const a of agents) {
    const src = read(path.join(agentsDir, `${a}.md`))
    fail(`agents/${a}`, lintAgent(a, parseFrontmatter(src)))
    fail(`agents/${a}`, unresolvedRefs(extractCraftRefs(src), known).map(r => `dangling craft:${r}`))
  }
  for (const f of fs.readdirSync(wfDir).filter(f => f.endsWith('.js'))) {
    const src = read(path.join(wfDir, f))
    fail(`workflows/${f}`, unresolvedRefs(extractCraftRefs(src), known).map(r => `dangling craft:${r}`))
  }

  console.log(`checked ${skills.length} skills, ${agents.length} agents, ${wfNames.length} workflows`)
  console.log(errors ? `\n${errors} problem(s)` : '\nall clean')
  process.exit(errors ? 1 : 0)
}
