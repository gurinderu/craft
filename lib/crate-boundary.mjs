// The observed crate boundary of a crateScope review run (realm @nick/craft, #316, #324): reads the run's
// agent transcripts (`<run-dir>/agent-*.jsonl`, each beside its `.meta.json`, whose `description` is the
// dispatch label) and, for every lens agent confined to a crate, lists the repository paths its Read, Grep,
// Glob and Bash calls touched outside its crate root. The confinement is words in a prompt; this is what the
// agents did. Run by the launcher after the run, like enrich-cost — the live sandbox cannot see transcripts.
//
// Run: node lib/crate-boundary.mjs <run-dir> [--repo <abs path>] [--json]
// A violation is a BODY read of an in-repo file outside the lens's crate: a Read, a cat/sed/head/tail/awk/less
// of it, or a search that prints context lines (-A/-B/-C). A signature search without context, a listing, a
// manifest or lockfile (shared by every slice) and a path outside the repository (a dependency source, the
// question channel) are listed apart, never counted.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isShared } from './lens-scope.mjs'

const READERS = new Set(['cat', 'sed', 'head', 'tail', 'less', 'more', 'nl', 'bat', 'awk', 'view'])
const SEARCHERS = new Set(['grep', 'egrep', 'rg', 'ag'])
const LISTERS = new Set(['ls', 'find', 'tree', 'fd'])
// The searchers' and readers' first operand is a pattern or a script, not a path.
const FIRST_OPERAND_IS_PROGRAM = new Set(['grep', 'egrep', 'rg', 'ag', 'sed', 'awk'])
const CONTEXT_FLAG = /^-(?:[ABC]\d*|-(?:context|after-context|before-context)(?:=.*)?)$/

/** The confined lens a dispatch label names: `lens:<profile>:<lens> r<n> crate:<root>[//<module>]`. @param {unknown} label */
export function confinedLensOf(label) {
  const m = /^lens:[^:]+:(\S+) .*?\bcrate:([^\s/][^\s]*?)(?:\/\/\S*)?(?:\s|$)/.exec(String(label ?? ''))
  if (!m || m[1] === 'contract') return null
  return { lens: String(m[1]), root: String(m[2]) }
}

// One shell token: a single- or double-quoted word, an operator that ends a command, or a bare word.
const TOKEN = /'([^']*)'|"([^"]*)"|([;&|()\n])|([^\s;&|()'"]+)/g

/** Shell words of one command, split into its simple commands, quotes stripped (no expansion). @param {string} cmd @returns {string[][]} */
export function shellSegments(cmd) {
  /** @type {string[][]} */
  const segs = [[]]
  for (const m of String(cmd).matchAll(TOKEN)) {
    const last = /** @type {string[]} */ (segs[segs.length - 1])
    if (m[3]) { if (last.length) segs.push([]) } else last.push(m[1] ?? m[2] ?? m[4] ?? '')
  }
  return segs.filter(seg => seg.length)
}

// The flags of the readers and searchers that take the next word as their value.
const VALUE_FLAGS = new Set(['-A', '-B', '-C', '-m', '-e', '-f', '-g', '-t', '-F', '-d', '-D', '--glob', '--type', '--include', '--exclude', '--max-count'])

/** A command's operands: its words that are neither flags nor a flag's value. @param {string[]} args */
function operandsOf(args) {
  /** @type {string[]} */
  const out = []
  for (let i = 0; i < args.length; i++) {
    const x = /** @type {string} */ (args[i])
    if (VALUE_FLAGS.has(x)) i++
    else if (!x.startsWith('-')) out.push(x)
  }
  return out
}

// A simple command's words with assignments and wrappers dropped, `git grep` read as grep.
/** @param {string[]} words */
function commandWords(words) {
  let w = words.filter(x => !/^\w+=/.test(x))
  if (w[0] === 'rtk' || w[0] === 'command' || w[0] === 'xargs') w = w.slice(1)
  return w[0] === 'git' && w[1] === 'grep' ? ['grep', ...w.slice(2)] : w
}

/** What a command does to the paths it names: read, search, body-search, list, or '' for anything else. @param {string} cmd @param {string[]} w */
function touchKind(cmd, w) {
  if (READERS.has(cmd)) return 'read'
  if (SEARCHERS.has(cmd)) return w.some(x => CONTEXT_FLAG.test(x)) ? 'body-search' : 'search'
  return LISTERS.has(cmd) ? 'list' : ''
}

/** The paths a command names; a search or listing that names none runs where it stands. @param {string} cmd @param {string[]} w @param {string} kind */
function namedPaths(cmd, w, kind) {
  const operands = operandsOf(w.slice(1))
  const paths = FIRST_OPERAND_IS_PROGRAM.has(cmd) && !w.includes('-e') ? operands.slice(1) : operands
  return paths.length || kind === 'read' ? paths : ['.']
}

/**
 * The path touches of one Bash command: `kind` read, search, body-search or list; `cd` moves the base.
 * @param {string} command @param {string} cwd
 * @returns {{ touches: Touch[], cwd: string }}
 */
export function bashTouches(command, cwd) {
  /** @type {Touch[]} */
  const touches = []
  let base = cwd
  for (const words of shellSegments(command)) {
    const w = commandWords(words)
    const cmd = path.basename(w[0] || '')
    if (cmd === 'cd' && w[1]) { base = path.resolve(base, w[1]); continue }
    const kind = touchKind(cmd, w)
    if (kind) for (const p of namedPaths(cmd, w, kind)) touches.push({ tool: `Bash:${cmd}`, kind, path: path.resolve(base, p) })
  }
  return { touches, cwd: base }
}

/** @typedef {{ tool: string, kind: string, path: string }} Touch */
/** @type {Record<string, (input: any, at: (p: unknown) => string) => Touch[]>} */
const TOOL_TOUCHES = {
  Read: (input, at) => (input.file_path ? [{ tool: 'Read', kind: 'read', path: at(input.file_path) }] : []),
  Grep: (input, at) => [{ tool: 'Grep', kind: input.output_mode === 'content' && ['-A', '-B', '-C', 'context'].some(k => Number(input[k]) > 0) ? 'body-search' : 'search', path: at(input.path) }],
  Glob: (input, at) => [{ tool: 'Glob', kind: 'list', path: at(input.path) }],
}

/**
 * The path touches of one tool call. @param {{ name?: unknown, input?: any }} use @param {string} cwd
 * @returns {{ touches: Touch[], cwd: string }}
 */
export function toolTouches(use, cwd) {
  const input = use.input && typeof use.input === 'object' ? use.input : {}
  if (use.name === 'Bash') return typeof input.command === 'string' ? bashTouches(input.command, cwd) : { touches: [], cwd }
  const touch = TOOL_TOUCHES[String(use.name)]
  return { touches: touch ? touch(input, p => path.resolve(cwd, typeof p === 'string' && p ? p : '.')) : [], cwd }
}

/** One transcript line as a record, null when it is not one. @param {string} line @returns {any} */
function recordOf(line) {
  try { return line.trim() ? JSON.parse(line) : null } catch { return null }
}

/** The tool calls of one assistant record. @param {any} rec @returns {Array<{ name?: unknown, input?: any }>} */
function toolUsesOf(rec) {
  const content = rec?.type === 'assistant' ? rec.message?.content : null
  return Array.isArray(content) ? content.filter(c => c?.type === 'tool_use').map(c => ({ name: c.name, input: c.input })) : []
}

/** The tool calls of one transcript, in order, and the cwd its first entry ran in. @param {string} text */
export function transcriptCalls(text) {
  const recs = String(text).split('\n').map(recordOf).filter(Boolean)
  const first = recs.find(r => typeof r?.cwd === 'string')
  return { uses: recs.flatMap(toolUsesOf), cwd: first ? String(first.cwd) : '' }
}

/**
 * Classify one touch against the lens's crate. @param {string} abs @param {string} repo @param {string} root
 * @returns {'own' | 'manifest' | 'outside-repo' | 'other'}
 */
export function placeOf(abs, repo, root) {
  const rel = path.relative(repo, abs).split(path.sep).join('/')
  if (rel.startsWith('..') || path.isAbsolute(rel)) return 'outside-repo'
  if (root === '.' || rel === root || rel.startsWith(`${root}/`)) return 'own'
  // A search or listing rooted at a directory that CONTAINS the crate reaches beyond it.
  return isShared(rel) ? 'manifest' : 'other'
}

/** @typedef {'violations' | 'searches' | 'lists' | 'manifests' | 'outsideRepo'} Bucket */
/** Where a touch outside the crate is listed. @param {'manifest' | 'outside-repo' | 'other'} place @param {string} kind @returns {Bucket} */
function bucketOf(place, kind) {
  if (place === 'outside-repo') return 'outsideRepo'
  if (place === 'manifest') return 'manifests'
  return kind === 'list' ? 'lists' : kind === 'search' ? 'searches' : 'violations'
}

/**
 * One confined lens agent's boundary.
 * @param {{ label: string, text: string, repo?: string }} a
 */
export function agentBoundary({ label, text, repo = '' }) {
  const lens = confinedLensOf(label)
  if (!lens) return null
  const { uses, cwd: first } = transcriptCalls(text)
  const repoRoot = repo || first || '/'
  let cwd = repoRoot
  /** @type {Record<Bucket, Array<{ tool: string, path: string }>>} */
  const out = { violations: [], searches: [], lists: [], manifests: [], outsideRepo: [] }
  for (const u of uses) {
    const r = toolTouches(u, cwd)
    cwd = r.cwd
    for (const t of r.touches) {
      const place = placeOf(t.path, repoRoot, lens.root)
      if (place !== 'own') out[bucketOf(place, t.kind)].push({ tool: t.tool, path: place === 'outside-repo' ? t.path : path.relative(repoRoot, t.path).split(path.sep).join('/') || '.' })
    }
  }
  return { label, ...lens, ...out }
}

/** Every confined lens agent of a run directory. @param {string} runDir @param {{ repo?: string }} [o] */
export function runBoundary(runDir, { repo = '' } = {}) {
  const names = fs.readdirSync(runDir).filter(n => /^agent-.*\.jsonl$/.test(n)).sort()
  const agents = []
  for (const n of names) {
    let label = ''
    try { label = String(JSON.parse(fs.readFileSync(path.join(runDir, n.replace(/\.jsonl$/, '.meta.json')), 'utf8')).description || '') } catch { continue }
    const b = agentBoundary({ label, text: fs.readFileSync(path.join(runDir, n), 'utf8'), repo })
    if (b) agents.push({ agent: n.replace(/^agent-|\.jsonl$/g, ''), ...b })
  }
  const breached = agents.filter(a => a.violations.length)
  return { agents, summary: { confinedAgents: agents.length, agentsWithViolations: breached.length, violations: breached.reduce((n, a) => n + a.violations.length, 0) } }
}

/** The report as text: one block per agent that left its crate. @param {ReturnType<typeof runBoundary>} r */
export function formatBoundary(r) {
  const lines = [`confined lens agents: ${r.summary.confinedAgents} · with body reads outside their crate: ${r.summary.agentsWithViolations} · such reads: ${r.summary.violations}`]
  for (const a of r.agents) {
    if (!a.violations.length && !a.searches.length) continue
    lines.push('', `${a.label}  [crate ${a.root}]`)
    for (const v of a.violations) lines.push(`  VIOLATION ${v.tool} ${v.path}`)
    for (const s of a.searches) lines.push(`  search    ${s.tool} ${s.path}`)
  }
  return lines.join('\n')
}

/** @param {string[]} argv */
export function main(argv) {
  const runDir = argv.find(a => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--repo')
  if (!runDir) throw new Error('usage: crate-boundary <run-dir> [--repo <abs path>] [--json]')
  const i = argv.indexOf('--repo')
  const r = runBoundary(runDir, { repo: i >= 0 ? String(argv[i + 1] || '') : '' })
  return argv.includes('--json') ? JSON.stringify(r, null, 2) : formatBoundary(r)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { process.stdout.write(`${main(process.argv.slice(2))}\n`) } catch (e) { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1 }
}
