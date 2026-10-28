// The command over lib/match-external-findings.mjs: reads each PR's review comments and reviews through `gh`, the
// review runs from the run store, and prints per external finding its ranked candidate ledger rows — or, given a
// decisions file, its bucket, the bucket counts and craft's confirmed Medium+ rows the reviewer never raised.
// Matching a mechanism stays a judgment (realm @nick/craft, node #378): the decisions file carries it,
//   { "<pr>:<finding id>": { "matches": [{ "rec": "<run ts prefix>", "fp": "<ledger fp>", "reason": "…" }], "note": "…", "bucket": "<override>" } }
// and a finding with no entry is one craft did not see. Node's standard library only, beside `gh` on the PATH.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { loadRecords } from './analyze-runs.mjs'
import { defaultReviewers, DEFAULT_SEVERITY } from './external-findings-parse.mjs'
import { BUCKETS, matchPr, tally, unmatchedDecisions } from './match-external-findings.mjs'
import { projectsOf } from './match-external-runs.mjs'
import { repoKey } from './repo-key.mjs'
import { outputLines, runIfMain } from './script-main.mjs'

/** @typedef {import('./match-external-findings.mjs').Decision} Decision @typedef {(args: string[]) => unknown} Gh @typedef {(dir: string) => string} Remotes */
/** @typedef {ReturnType<typeof matchPr>} PrMatch @typedef {{ stdout: string[], stderr: string[] }} Lines */

export const USAGE = 'usage: node lib/match-external-findings-cli.mjs --repo <owner/name> --pr <n> [--pr <n>…] [--reviewer <login>[,<login>…]] '
  + '[--id-regex <re>] [--exclude-regex <re>] [--sev-regex <re>] [--runs-dir <dir>] [--project <checkout>] [--cache-dir <dir>] [--decisions <file>] [--json <file>]'
const TOP = 4

/** `gh` with an argument array (no shell), its stdout parsed as JSON. @type {Gh} */
const ghJson = args => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 28, timeout: 600_000 }))
/** `git remote -v` in a recorded project's checkout; '' when it is gone or not a repository. @type {Remotes} */
const gitRemotes = dir => {
  try { return execFileSync('git', ['-C', dir, 'remote', '-v'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }) } catch { return '' }
}

/** @param {string | undefined} v @param {string} [flags] */
const regex = (v, flags) => (v ? new RegExp(v, flags) : null)

/** A PR number, else a thrown usage error. @param {string} p */
function prNumber(p) {
  if (!/^[1-9]\d*$/.test(p)) throw new Error(`--pr ${p}: not a PR number`)
  return Number(p)
}

/** @param {string[]} argv */
function options(argv) {
  const s = /** @type {const} */ ({ type: 'string' })
  const { values: v } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
    repo: s, pr: { type: 'string', multiple: true }, reviewer: { type: 'string', multiple: true }, 'id-regex': s, 'exclude-regex': s,
    'sev-regex': s, 'runs-dir': s, project: s, 'cache-dir': s, decisions: s, json: s } })
  if (!/^[\w.-]+\/[\w.-]+$/.test(v.repo ?? '')) throw new Error('--repo <owner/name> is required')
  const prs = (v.pr ?? []).map(prNumber)
  if (!prs.length) throw new Error('at least one --pr <n> is required')
  const reviewers = v.reviewer?.flatMap(r => r.split(',')).filter(Boolean)
  return { repo: String(v.repo), prs, reviewers: reviewers?.length ? reviewers : null, idRe: regex(v['id-regex']), exRe: regex(v['exclude-regex'], 'i'),
    sevRe: regex(v['sev-regex'], 'i') ?? DEFAULT_SEVERITY, runsDir: v['runs-dir'], project: v.project, cacheDir: v['cache-dir'] ?? null, decisions: v.decisions, json: v.json }
}

/** The decisions file: an object of `<pr>:<id>` entries, each bucket override one of BUCKETS. @param {string} file @returns {Record<string, Decision>} */
export function readDecisions(file) {
  const d = /** @type {unknown} */ (JSON.parse(fs.readFileSync(file, 'utf8')))
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error(`${file}: not an object of "<pr>:<id>" decisions`)
  for (const [k, e] of Object.entries(/** @type {Record<string, Decision>} */ (d))) {
    if (e.bucket && !BUCKETS.includes(e.bucket)) throw new Error(`${file}: ${k}: bucket ${e.bucket} is not one of ${BUCKETS.join(', ')}`)
    if (e.matches && !Array.isArray(e.matches)) throw new Error(`${file}: ${k}: matches is not an array`)
  }
  return /** @type {Record<string, Decision>} */ (d)
}

/** One PR's comments and view, through the cache when one is named. @param {Gh} gh @param {string} repo @param {number} n @param {string | null} cacheDir */
function fetchPr(gh, repo, n, cacheDir) {
  /** @param {string} kind @param {() => unknown} fetch */
  const load = (kind, fetch) => {
    const f = cacheDir ? path.join(cacheDir, `${repo.replace('/', '_')}-${n}.${kind}.json`) : null
    if (f && fs.existsSync(f)) return /** @type {unknown} */ (JSON.parse(fs.readFileSync(f, 'utf8')))
    const d = fetch()
    if (f) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(d)) }
    return d
  }
  // --paginate --slurp: one array of pages, each page an array of comments.
  const comments = load('comments', () => /** @type {unknown[]} */ (gh(['api', `repos/${repo}/pulls/${n}/comments`, '--paginate', '--slurp'])).flat())
  const pr = load('pr', () => gh(['pr', 'view', String(n), '--repo', repo, '--json', 'reviews,headRefName,commits,author']))
  return { comments: /** @type {import('./external-findings-parse.mjs').PrComment[]} */ (comments), pr: /** @type {import('./external-findings-parse.mjs').PrView} */ (pr) }
}

/** @param {unknown} v */
const dash = v => (v == null || v === '' ? '-' : String(v))

/** @param {PrMatch['results'][number]} r @param {Lines} o */
function renderFinding(r, o) {
  const at = `${r.id} [${dash(r.sev)}] ${dash(r.path)}:${dash(r.line)}`
  if (r.bucket) { o.stdout.push(`${at} -> ${r.bucket}${r.note ? ` (${r.note})` : ''}`); return }
  o.stdout.push(`${at} — ${r.nCands} candidate(s)`)
  for (const c of r.cands) {
    o.stdout.push(`  ${c.score.toFixed(3)} ${c.rec} ${dash(c.head)} ${c.fp} ${c.file}:${dash(c.line)} ${dash(c.sev)}/${dash(c.tier)}${c.before ? '' : ' (after)'} ${c.title.slice(0, 100)}`)
  }
}

/** @param {number} n @param {PrMatch} p @param {Lines} o */
function render(n, p, o) {
  o.stdout.push(`\n## PR ${n} ${p.head} reviewers=${p.reviewers.join(',')} findings=${p.results.length} excluded=${p.excluded} skippedNoId=${p.unanchored} runs=${p.runs.length}`)
  o.stdout.push(`delta runs: ${p.deltaRuns} (not counted as coverage)`)
  for (const r of p.results) renderFinding(r, o)
  if (!p.craftOnly) return
  o.stdout.push(`craft confirmed Medium+ the reviewer never raised: ${p.craftOnly.length}`)
  for (const c of p.craftOnly) o.stdout.push(`  ${c.fp} [${c.sev}] ${c.file}:${dash(c.line)} ${c.title.slice(0, 100)} (first ${c.firstRun})`)
}

/** The run store's records and the projects among them that are `--repo`'s. @param {ReturnType<typeof options>} opt @param {Remotes} remotesOf @param {string} home @param {Lines} o */
function store(opt, remotesOf, home, o) {
  const runsDir = opt.runsDir ?? path.join(home, '.craft', 'runs')
  const loaded = loadRecords(runsDir)
  if (!loaded) throw new Error(`no run store at ${runsDir}`)
  if (loaded.unreadable.length) o.stderr.push(`${loaded.unreadable.length} unreadable record(s) in ${runsDir} skipped`)
  const projects = opt.project ? new Set([repoKey(opt.project)]) : projectsOf(loaded.records, opt.repo, remotesOf)
  if (!projects.size) throw new Error(`no project in ${runsDir} is a checkout of ${opt.repo} (by its git remotes): name the checkout with --project`)
  o.stdout.push(`projects: ${[...projects].join(', ')}`)
  return { loaded, projects }
}

/**
 * Every PR matched and rendered, over the runs of the projects that are checkouts of `--repo` (by their git
 * remotes), or of the one `--project` names.
 * @param {ReturnType<typeof options>} opt @param {Gh} gh @param {Remotes} remotesOf @param {string} home @param {Lines} o
 */
function matchAll(opt, gh, remotesOf, home, o) {
  const { loaded, projects } = store(opt, remotesOf, home, o)
  const decisions = opt.decisions ? readDecisions(opt.decisions) : null
  /** @type {Record<string, PrMatch>} */
  const prs = {}
  for (const n of opt.prs) {
    const { comments, pr } = fetchPr(gh, opt.repo, n, opt.cacheDir)
    const options = { reviewers: opt.reviewers ?? defaultReviewers(pr, comments), idRe: opt.idRe, exRe: opt.exRe, sevRe: opt.sevRe }
    const p = matchPr({ pr, comments, records: loaded.records, projects, options, decisions, n, top: TOP })
    prs[n] = p
    render(n, p, o)
  }
  const unmatched = decisions ? unmatchedDecisions(decisions, prs) : []
  if (decisions) o.stdout.push('\nCOUNTS (pr|severity|bucket):', ...tally(prs).map(([k, v]) => `${k} ${v}`))
  o.stdout.push(...unmatched.map(k => `WARNING: decision ${k} matches no finding`))
  return { projects: [...projects], prs, unmatchedDecisions: unmatched }
}

/**
 * @param {string[]} argv @param {NodeJS.ProcessEnv} _env  unused: the home directory comes from `deps`
 * @param {{ gh?: Gh, remotesOf?: Remotes, home?: string }} [deps]  `gh`, the git remotes of a project and the home whose ~/.craft/runs is read; tests replace them
 * @returns {Promise<import('./script-main.mjs').ScriptResult>}
 */
export async function run(argv, _env, { gh = ghJson, remotesOf = gitRemotes, home = os.homedir() } = {}) {
  const o = outputLines()
  /** @type {0 | 1 | 2} */
  let exitCode = 2
  try {
    const opt = options(argv)
    exitCode = 1
    const result = matchAll(opt, gh, remotesOf, home, o)
    if (opt.json) fs.writeFileSync(opt.json, JSON.stringify(result, null, 1))
    exitCode = 0
  } catch (e) {
    // A usage error (exit 2) also shows the usage line; a failure past it (exit 1) only its message.
    o.stderr.push(/** @type {Error} */ (e).message, ...(exitCode === 2 ? [USAGE] : []))
  }
  return { exitCode, ...o }
}

await runIfMain(import.meta.url, run)
