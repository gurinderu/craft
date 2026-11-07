// The observed unit boundary of a unitScope review run (realm @nick/craft, #316, #324): reads the run's
// agent transcripts (realm @nick/craft, node #367: `<run-dir>/agent-*.jsonl`, each beside its `.meta.json`,
// whose `description` is the dispatch label) and, for every lens agent confined to a unit, lists the repository
// paths its Read, Grep, Glob and Bash calls touched outside its unit root. The confinement is words in a
// prompt; this is what the agents did. Run by the launcher after the run, like enrich-cost — the live sandbox
// cannot see transcripts.
//
// Run: node lib/unit-boundary.mjs <run-dir> [--repo <abs path>] [--json]
// A violation is a BODY read of an in-repo file outside the lens's unit: a Read, a cat/sed/head/tail/awk/less
// of it, a `git show <rev>:<path>` or `git cat-file -p <rev>:<path>`, or a search that prints context lines
// (-A/-B/-C). A signature search without context, a listing, a manifest or lockfile (shared by every slice) and
// a path outside the repository (a dependency source, the question channel) are listed apart, never counted.
// The contract lens (#327) reads signatures and call sites, never bodies: its body reads outside its unit are
// counted in a bucket of their own, apart from the confined lenses' violations. A reader `xargs` runs on paths
// no command of its line named (`echo … | xargs cat`) is listed as unattributed: a read whose place is unknown.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isShared } from './lens-scope.mjs'
import { bashTouches } from './shell-touches.mjs'

// A unit batch (realm @nick/craft, #355) names each of its units, `unit:<a> unit:<b>`, and is one boundary.
/** The confined lens a dispatch label names: `lens:<profile>:<lens> r<n> unit:<root>[//<module>] [unit:<root>...]`. @param {unknown} label */
export function confinedLensOf(label) {
  const text = String(label ?? '')
  const m = /^lens:[^:]+:(\S+) /.exec(text)
  const roots = [...text.matchAll(/(?:^|\s)unit:([^\s/][^\s]*?)(?:\/\/\S*)?(?=\s|$)/g)].map(r => String(r[1]))
  if (!m || !roots.length) return null
  return { lens: String(m[1]), root: String(roots[0]), roots }
}
/** @typedef {import('./shell-touches.mjs').Touch} Touch */
/** @type {Record<string, (input: any, at: (p: unknown) => string) => Touch[]>} */
const TOOL_TOUCHES = {
  Read: (input, at) => (input.file_path ? [{ tool: 'Read', kind: 'read', path: at(input.file_path) }] : []),
  Grep: (input, at) => [{ tool: 'Grep', kind: input.output_mode === 'content' && ['-A', '-B', '-C', 'context'].some(k => Number(input[k]) > 0) ? 'body-search' : 'search', path: at(input.path) }],
  Glob: (input, at) => [{ tool: 'Glob', kind: 'list', path: at(input.path) }],
}

/**
 * The path touches of one tool call. @param {{ name?: unknown, input?: any }} use @param {string} cwd @param {string} [repo]
 * @returns {{ touches: Touch[], cwd: string }}
 */
export function toolTouches(use, cwd, repo = cwd) {
  const input = use.input && typeof use.input === 'object' ? use.input : {}
  if (use.name === 'Bash') return typeof input.command === 'string' ? bashTouches(input.command, cwd, repo) : { touches: [], cwd }
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
 * Classify one touch against the lens's unit, or the units of its batch. @param {string} abs @param {string} repo @param {string | string[]} root
 * @returns {'own' | 'manifest' | 'outside-repo' | 'other'}
 */
export function placeOf(abs, repo, root) {
  const rel = path.relative(repo, abs).split(path.sep).join('/')
  if (rel.startsWith('..') || path.isAbsolute(rel)) return 'outside-repo'
  if ((Array.isArray(root) ? root : [root]).some(r => r === '.' || rel === r || rel.startsWith(`${r}/`))) return 'own'
  // A search or listing rooted at a directory that CONTAINS the unit reaches beyond it.
  return isShared(rel) ? 'manifest' : 'other'
}

/** @typedef {'violations' | 'searches' | 'lists' | 'manifests' | 'outsideRepo' | 'unattributed'} Bucket */
/** Where a touch outside the unit is listed. @param {'manifest' | 'outside-repo' | 'other'} place @param {string} kind @returns {Bucket} */
function bucketOf(place, kind) {
  if (place === 'outside-repo') return 'outsideRepo'
  if (place === 'manifest') return 'manifests'
  return kind === 'list' ? 'lists' : kind === 'search' ? 'searches' : 'violations'
}

/**
 * One touch listed in its bucket; one in the lens's own units is not listed.
 * @param {Record<Bucket, Array<{ tool: string, path: string }>>} out @param {Touch} t @param {string} repoRoot @param {string[]} roots
 */
function listTouch(out, t, repoRoot, roots) {
  if (t.kind === 'unattributed') return void out.unattributed.push({ tool: t.tool, path: t.command ?? '' })
  const place = placeOf(t.path, repoRoot, roots)
  if (place !== 'own') out[bucketOf(place, t.kind)].push({ tool: t.tool, path: place === 'outside-repo' ? t.path : path.relative(repoRoot, t.path).split(path.sep).join('/') || '.' })
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
  const out = { violations: [], searches: [], lists: [], manifests: [], outsideRepo: [], unattributed: [] }
  for (const u of uses) {
    const r = toolTouches(u, cwd, repoRoot)
    cwd = r.cwd
    for (const t of r.touches) listTouch(out, t, repoRoot, lens.roots)
  }
  return { label, ...lens, ...out }
}

/** Every confined lens agent of a run directory. @param {string} runDir @param {{ repo?: string }} [o] */
export function runBoundary(runDir, { repo = '' } = {}) {
  const names = fs.readdirSync(runDir).filter(n => /^agent-.*\.jsonl$/.test(n)).sort()
  /** @type {Array<{ agent: string } & NonNullable<ReturnType<typeof agentBoundary>>>} */
  const agents = []
  for (const n of names) {
    let label = ''
    try { label = String(JSON.parse(fs.readFileSync(path.join(runDir, n.replace(/\.jsonl$/, '.meta.json')), 'utf8')).description || '') } catch { continue }
    const b = agentBoundary({ label, text: fs.readFileSync(path.join(runDir, n), 'utf8'), repo })
    if (b) agents.push({ agent: n.replace(/^agent-|\.jsonl$/g, ''), ...b })
  }
  const tally = (/** @type {typeof agents} */ as) => ({ agents: as.length, breached: as.filter(a => a.violations.length).length, reads: as.reduce((n, a) => n + a.violations.length, 0) })
  const lens = tally(agents.filter(a => a.lens !== 'contract'))
  const contract = tally(agents.filter(a => a.lens === 'contract'))
  return { agents, summary: {
    confinedAgents: lens.agents, agentsWithViolations: lens.breached, violations: lens.reads,
    contractAgents: contract.agents, contractAgentsWithBodyReads: contract.breached, contractBodyReads: contract.reads,
    unattributedReads: agents.reduce((n, a) => n + a.unattributed.length, 0),
  } }
}

/** The report as text: one block per agent that left its unit. @param {ReturnType<typeof runBoundary>} r */
export function formatBoundary(r) {
  const s = r.summary
  const lines = [
    `confined lens agents: ${s.confinedAgents} · with body reads outside their unit: ${s.agentsWithViolations} · such reads: ${s.violations}`,
    `contract lens agents: ${s.contractAgents} · with body reads outside their unit: ${s.contractAgentsWithBodyReads} · such reads: ${s.contractBodyReads}`,
    `reads of paths no command named (unattributed): ${s.unattributedReads}`,
  ]
  for (const a of r.agents) {
    if (!a.violations.length && !a.searches.length && !a.unattributed.length) continue
    lines.push('', `${a.label}  [${a.roots.length > 1 ? `units ${a.roots.join(', ')}` : `unit ${a.root}`}]`)
    for (const v of a.violations) lines.push(`  ${a.lens === 'contract' ? 'BODY READ' : 'VIOLATION'} ${v.tool} ${v.path}`)
    for (const s of a.searches) lines.push(`  search    ${s.tool} ${s.path}`)
    for (const u of a.unattributed) lines.push(`  UNATTRIBUTED ${u.tool} ${u.path}`)
  }
  return lines.join('\n')
}

/** @param {string[]} argv */
export function main(argv) {
  const runDir = argv.find(a => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--repo')
  if (!runDir) throw new Error('usage: unit-boundary <run-dir> [--repo <abs path>] [--json]')
  const i = argv.indexOf('--repo')
  const r = runBoundary(runDir, { repo: i >= 0 ? String(argv[i + 1] || '') : '' })
  return argv.includes('--json') ? JSON.stringify(r, null, 2) : formatBoundary(r)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { process.stdout.write(`${main(process.argv.slice(2))}\n`) } catch (e) { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1 }
}
