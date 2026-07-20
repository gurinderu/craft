// Static integrity check for the collection's authored config: every skill and agent has a valid
// frontmatter block, its `name` matches the directory/file it lives in, and every internal
// `craft:<slug>` cross-reference in any skill/agent/workflow resolves to a real skill, agent, or
// workflow. Catches the failure class that `node --test` can't: a renamed skill leaving a dangling
// `craft:` pointer, or a new skill shipped with a malformed/empty description. Pure helpers are
// exported for the unit test; the filesystem walk + process.exit live at the bottom (CLI mode).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Parse a Markdown YAML frontmatter block into a Map of top-level key -> collapsed string value.
// Handles both inline scalars (`name: foo`, `tools: ["Read"]`) and folded/literal block scalars
// (`description: >-` followed by indented continuation lines). Returns null when there is no
// frontmatter block at all. Not a general YAML parser — only what this collection's frontmatter uses.
export function parseFrontmatter(src) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src)
  if (!m) return null
  const keys = new Map()
  let curKey = null
  let parts = []
  const flush = () => { if (curKey !== null) keys.set(curKey, parts.join(' ').replace(/\s+/g, ' ').trim()) }
  for (const line of m[1].split(/\r?\n/)) {
    const km = /^([A-Za-z][\w-]*):(.*)$/.exec(line) // top-level key: indented lines never match `^[A-Za-z]`
    if (km) {
      flush()
      curKey = km[1]
      const inline = km[2].trim()
      parts = inline && !/^[|>][+-]?$/.test(inline) ? [inline] : [] // drop a bare block indicator (>- | …)
    } else if (curKey !== null) {
      parts.push(line.trim())
    }
  }
  flush()
  return keys
}

// Lint one skill's frontmatter. `dirName` is the skill's directory basename (its canonical id).
export function lintSkill(dirName, keys) {
  if (!keys) return ['no frontmatter block']
  const errs = []
  const name = keys.get('name')
  if (!name) errs.push('missing name')
  else if (name !== dirName) errs.push(`name "${name}" != dir "${dirName}"`)
  if (!keys.get('description')) errs.push('missing/empty description')
  return errs
}

// Lint one agent's frontmatter. `fileBase` is the agent file's basename without .md (its id).
export function lintAgent(fileBase, keys) {
  if (!keys) return ['no frontmatter block']
  const errs = []
  const name = keys.get('name')
  if (!name) errs.push('missing name')
  else if (name !== fileBase) errs.push(`name "${name}" != file "${fileBase}"`)
  if (!keys.get('description')) errs.push('missing/empty description')
  if (!keys.get('tools')) errs.push('missing tools')
  if (!keys.get('model')) errs.push('missing model')
  return errs
}

// All internal `craft:<slug>` references found in a blob of text (skill body, agent prompt, …).
export function extractCraftRefs(text) {
  const out = new Set()
  for (const m of text.matchAll(/craft:([a-z][a-z0-9-]*)/g)) out.add(m[1])
  return out
}

// Which of `refs` do not resolve against the set of known ids (skills ∪ agents ∪ workflows).
export function unresolvedRefs(refs, known) {
  return [...refs].filter(r => !known.has(r)).sort()
}

// Every `<plugin>:<slug>` reference to a plugin listed in `foreign`. craft is self-contained —
// it declares no plugin dependencies and must not name another plugin's skills in its bodies — so
// the CLI fails when one of these reappears (e.g. a re-introduced `superpowers:` deferral).
export function extractForeignRefs(text, foreign) {
  const out = new Set()
  for (const m of text.matchAll(/\b([a-z][a-z0-9-]*):([a-z][a-z0-9-]*)/g)) {
    if (foreign.has(m[1])) out.add(`${m[1]}:${m[2]}`)
  }
  return [...out].sort()
}

// Every Markdown file under `dir`, recursively (a skill's SKILL.md plus every sub-file, including
// ones nested in subdirectories). Returned as absolute paths. Used to scan a whole skill for
// foreign-plugin refs, not just its top-level files.
export function collectMdFiles(dir) {
  return fs.readdirSync(dir, { recursive: true })
    .filter(f => f.endsWith('.md'))
    .map(f => path.join(dir, f))
}

// Dependency entries (plugin.json `dependencies` + each marketplace plugin's `dependencies`) whose
// plugin name is in `foreign`. Dependency form is `name` or `name@marketplace` — NOT the `name:slug`
// body form — so this is a separate check from extractForeignRefs.
export function foreignDependencies(manifest, foreign) {
  const deps = [
    ...(manifest.dependencies || []),
    ...((manifest.plugins || []).flatMap(p => p.dependencies || [])),
  ]
  return deps.filter(d => foreign.has(String(d).split('@')[0])).sort()
}

// ── CLI mode ──────────────────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const read = p => fs.readFileSync(p, 'utf8')
  let errors = 0
  const fail = (where, msgs) => { for (const m of msgs) { console.error('FAIL ', where, '::', m); errors++ } }

  const skillsDir = path.join(root, 'skills')
  const skills = fs.readdirSync(skillsDir).filter(d => fs.existsSync(path.join(skillsDir, d, 'SKILL.md'))).sort()
  const agentsDir = path.join(root, 'agents')
  const agents = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)).sort()
  const wfDir = path.join(root, 'workflows')
  const wfNames = fs.readdirSync(wfDir).filter(f => f.endsWith('.js')) // meta.name is the first `name:` in each script
    .map(f => /name:\s*'([a-z][a-z0-9-]*)'/.exec(read(path.join(wfDir, f)))?.[1]).filter(Boolean)
  const known = new Set([...skills, ...agents, ...wfNames])

  // Plugins craft must stay decoupled from: a `<plugin>:<slug>` ref to any of these fails the check.
  const FOREIGN = new Set(['superpowers'])
  const foreign = src => extractForeignRefs(src, FOREIGN).map(r => `foreign plugin ref ${r} (craft is self-contained)`)

  for (const s of skills) {
    const skillDir = path.join(skillsDir, s)
    const src = read(path.join(skillDir, 'SKILL.md'))
    fail(`skills/${s}`, lintSkill(s, parseFrontmatter(src)))
    fail(`skills/${s}`, unresolvedRefs(extractCraftRefs(src), known).map(r => `dangling craft:${r}`))
    // Foreign-plugin refs are forbidden in the whole skill: SKILL.md + every sub-file, recursively.
    for (const md of collectMdFiles(skillDir)) {
      fail(`skills/${s}/${path.relative(skillDir, md)}`, foreign(read(md)))
    }
  }
  for (const a of agents) {
    const src = read(path.join(agentsDir, `${a}.md`))
    fail(`agents/${a}`, lintAgent(a, parseFrontmatter(src)))
    fail(`agents/${a}`, unresolvedRefs(extractCraftRefs(src), known).map(r => `dangling craft:${r}`))
    fail(`agents/${a}`, foreign(src))
  }
  for (const f of fs.readdirSync(wfDir).filter(f => f.endsWith('.js'))) {
    const src = read(path.join(wfDir, f))
    fail(`workflows/${f}`, unresolvedRefs(extractCraftRefs(src), known).map(r => `dangling craft:${r}`))
    fail(`workflows/${f}`, foreign(src))
  }

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

  console.log(`checked ${skills.length} skills, ${agents.length} agents, ${wfNames.length} workflows`)
  console.log(errors ? `\n${errors} problem(s)` : '\nall clean')
  process.exit(errors ? 1 : 0)
}
