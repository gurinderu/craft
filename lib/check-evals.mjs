// Static shape-check for the skill-triggering eval corpus (evals/evals.json). The corpus itself is
// run against a live model via the skill-creator skill (see evals/README.md) — that can't live in
// CI. What CI *can* guard is that the JSON stays well-formed and every skill it references is real:
// a renamed/deleted skill leaving a dangling `skills: [...]` pointer, an empty query, or a malformed
// case is caught here without a model. Pure helpers are exported for the unit test; the file read +
// process.exit live at the bottom (CLI mode). No deps beyond node built-ins.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Lint one eval case against the Anthropic rubric shape:
//   { skills: ["<id>", …], query: "<prompt>", expected_behavior: ["<assertion>", …] }
// `known` is the set of real skill ids (dir basenames under skills/). Returns a list of problems
// (empty = clean). `idx` is only used to prefix messages for the CLI.
export function lintEvalCase(c, known, idx = 0) {
  const errs = []
  const at = `case[${idx}]`
  if (c === null || typeof c !== 'object' || Array.isArray(c)) return [`${at} is not an object`]

  if (!Array.isArray(c.skills) || c.skills.length === 0) {
    errs.push(`${at} skills must be a non-empty array`)
  } else {
    for (const s of c.skills) {
      if (typeof s !== 'string' || !s.trim()) errs.push(`${at} skills has a non-string/empty entry`)
      else if (!known.has(s)) errs.push(`${at} references unknown skill "${s}"`)
    }
  }

  if (typeof c.query !== 'string' || !c.query.trim()) errs.push(`${at} query must be a non-empty string`)

  if (!Array.isArray(c.expected_behavior) || c.expected_behavior.length === 0) {
    errs.push(`${at} expected_behavior must be a non-empty array`)
  } else if (c.expected_behavior.some(a => typeof a !== 'string' || !a.trim())) {
    errs.push(`${at} expected_behavior has a non-string/empty assertion`)
  }

  return errs
}

// Lint the whole corpus. `parsed` is the value of JSON.parse(evals.json). Also flags duplicate
// queries (a copy-paste slip that silently weakens coverage). Returns a flat list of problems.
export function lintCorpus(parsed, known) {
  if (!Array.isArray(parsed)) return ['corpus root must be a JSON array']
  if (parsed.length === 0) return ['corpus is empty']
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
export function knownSkills(skillsDir) {
  return new Set(fs.readdirSync(skillsDir).filter(d => fs.existsSync(path.join(skillsDir, d, 'SKILL.md'))))
}

// ── CLI mode ──────────────────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const evalsPath = path.join(root, 'evals', 'evals.json')
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(evalsPath, 'utf8'))
  } catch (e) {
    console.error('FAIL  evals/evals.json ::', e.message)
    process.exit(1)
  }
  const known = knownSkills(path.join(root, 'skills'))
  const problems = lintCorpus(parsed, known)
  for (const p of problems) console.error('FAIL  evals/evals.json ::', p)
  const n = Array.isArray(parsed) ? parsed.length : 0
  console.log(`checked ${n} eval case(s) against ${known.size} skills`)
  console.log(problems.length ? `\n${problems.length} problem(s)` : '\nall clean')
  process.exit(problems.length ? 1 : 0)
}
