// Static shape-check for the skill-triggering eval corpus (evals/evals.json). The corpus itself is
// run against a live model via the skill-creator skill (see evals/README.md) — that can't live in
// CI. What CI *can* guard is that the JSON stays well-formed and every skill it references is real:
// a renamed/deleted skill leaving a dangling `skills: [...]` pointer, an empty query, or a malformed
// case is caught here without a model. Pure helpers are exported for the unit test; the file read
// lives in `run` at the bottom (CLI mode). No deps beyond node built-ins.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runIfMain } from './script-main.mjs'

// Lint one eval case against the Anthropic rubric shape:
//   { skills: ["<id>", …], query: "<prompt>", expected_behavior: ["<assertion>", …] }
// `known` is the set of real skill ids (dir basenames under skills/). Returns a list of problems
// (empty = clean). `idx` is only used to prefix messages for the CLI.
/**
 * @param {unknown} c
 * @param {Set<string>} known
 * @param {number} [idx]
 * @returns {string[]}
 */
export function lintEvalCase(c, known, idx = 0) {
  const at = `case[${idx}]`
  if (c === null || typeof c !== 'object' || Array.isArray(c)) return [`${at} is not an object`]
  const e = /** @type {Record<string, unknown>} */ (c)
  const errs = skillsProblems(e['skills'], known, at)
  if (typeof e['query'] !== 'string' || !e['query'].trim()) errs.push(`${at} query must be a non-empty string`)
  errs.push(...expectedBehaviorProblems(e['expected_behavior'], at))
  return errs
}

/** @param {unknown} skills @param {Set<string>} known @param {string} at @returns {string[]} */
function skillsProblems(skills, known, at) {
  if (!Array.isArray(skills) || skills.length === 0) return [`${at} skills must be a non-empty array`]
  /** @type {string[]} */
  const errs = []
  for (const s of skills) {
    if (typeof s !== 'string' || !s.trim()) errs.push(`${at} skills has a non-string/empty entry`)
    else if (!known.has(s)) errs.push(`${at} references unknown skill "${s}"`)
  }
  return errs
}

/** @param {unknown} expected @param {string} at @returns {string[]} */
function expectedBehaviorProblems(expected, at) {
  if (!Array.isArray(expected) || expected.length === 0) return [`${at} expected_behavior must be a non-empty array`]
  if (expected.some((/** @type {unknown} */ a) => typeof a !== 'string' || !a.trim())) return [`${at} expected_behavior has a non-string/empty assertion`]
  return []
}

// Lint the whole corpus. `parsed` is the value of JSON.parse(evals.json). Also flags duplicate
// queries (a copy-paste slip that silently weakens coverage). Returns a flat list of problems.
/**
 * @param {unknown} parsed
 * @param {Set<string>} known
 * @returns {string[]}
 */
export function lintCorpus(parsed, known) {
  if (!Array.isArray(parsed)) return ['corpus root must be a JSON array']
  if (parsed.length === 0) return ['corpus is empty']
  /** @type {string[]} */
  const errs = []
  const seen = new Map()
  parsed.forEach((c, i) => {
    errs.push(...lintEvalCase(c, known, i))
    const q = c && typeof c.query === 'string' ? c.query.trim() : null
    if (q) { if (seen.has(q)) errs.push(`case[${i}] duplicate query (also case[${seen.get(q)}])`); else seen.set(q, i) }
  })
  return errs
}

// The set of real skill ids: every directory under `skillsDir` that has a SKILL.md.
/** @param {string} skillsDir */
export function knownSkills(skillsDir) {
  return new Set(fs.readdirSync(skillsDir).filter(d => fs.existsSync(path.join(skillsDir, d, 'SKILL.md'))))
}

// ── CLI mode ──────────────────────────────────────────────────────────────────────────────────
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** @typedef {{ stdout: string[], stderr: string[] }} Lines */
/**
 * Lints evals/evals.json against the skills under `root`; takes no arguments.
 * @param {string[]} _argv @param {NodeJS.ProcessEnv} _env  unused: it reads no environment
 * @param {string} [root]  the checkout to check
 * @returns {Promise<import('./script-main.mjs').ScriptResult>}
 */
export async function run(_argv, _env, root = ROOT) {
  /** @type {Lines} */
  const o = { stdout: [], stderr: [] }
  const evalsPath = path.join(root, 'evals', 'evals.json')
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(evalsPath, 'utf8'))
  } catch (e) {
    o.stderr.push(`FAIL  evals/evals.json :: ${/** @type {any} */ (e).message}`)
    return { exitCode: 1, ...o }
  }
  const known = knownSkills(path.join(root, 'skills'))
  const problems = lintCorpus(parsed, known)
  for (const p of problems) o.stderr.push(`FAIL  evals/evals.json :: ${p}`)
  const n = Array.isArray(parsed) ? parsed.length : 0
  o.stdout.push(`checked ${n} eval case(s) against ${known.size} skills`)
  o.stdout.push(problems.length ? `\n${problems.length} problem(s)` : '\nall clean')
  return { exitCode: problems.length ? 1 : 0, ...o }
}

await runIfMain(import.meta.url, run)
